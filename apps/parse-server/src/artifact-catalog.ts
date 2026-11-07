import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { artifactKey, canonicalJson, type ArtifactIdentity } from './artifact-store'
import type { MysqlDatabase } from './mysql'

export interface ArtifactLease {
  key: string
  jobId: string
  owner: string
  generation: number
  leaseUntil: number
}
export interface ReadyArtifact {
  key: string
  generation: number
  storagePath: string
  manifestSha256: string
  bytes: number
  unitCount: number
}
export interface ArtifactReadLease {
  id: string
  key: string
  generation: number
  owner: string
  leaseUntil: number
}
export interface ArtifactArchive {
  key: string
  fileId: string
  generation: number
  retiredGenerations: number
  flatArchived: boolean
  archivedAt: number
}
export type ArtifactClaim = { kind: 'acquired'; lease: ArtifactLease }
  | { kind: 'busy'; leaseUntil: number }
  | { kind: 'ready'; artifact: ReadyArtifact }

const HASH = /^[a-f0-9]{64}$/
function integer(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid catalog integer')
  return number
}
export function artifactGenerationPath(key: string, generation: number): string {
  if (!HASH.test(key) || integer(generation) < 1) throw new Error('invalid artifact generation')
  return `artifacts/${key.slice(0, 2)}/${key}/g-${generation}`
}

/** SQL fencing only. Callers must publish immutable generation files BEFORE recording readiness. */
export class MysqlArtifactCatalog {
  constructor(private readonly db: MysqlDatabase, readonly leaseMs = 30_000) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 600_000)
      throw new Error('invalid artifact lease duration')
  }

  private async transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.db.pool.getConnection()
    try {
      await connection.beginTransaction()
      const result = await work(connection)
      await connection.commit()
      return result
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally { connection.release() }
  }

  private async now(connection: PoolConnection): Promise<number> {
    const [rows] = await connection.query<RowDataPacket[]>(
      'SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 AS UNSIGNED) AS now_ms',
    )
    return integer(rows[0].now_ms)
  }

  private ready(row: RowDataPacket): ReadyArtifact | null {
    if (row.ready_generation === null) return null
    const generation = integer(row.ready_generation)
    const expected = artifactGenerationPath(row.artifact_key, generation)
    if (row.storage_path !== expected || !HASH.test(row.manifest_sha256))
      throw new Error('invalid ready artifact pointer')
    return { key: row.artifact_key, generation, storagePath: expected,
      manifestSha256: row.manifest_sha256, bytes: integer(row.bytes), unitCount: integer(row.unit_count) }
  }

  /** Compare-and-clear only the exact corrupt ready pointer; existing readers keep their pins. */
  invalidateReady(expected: Readonly<ReadyArtifact>): Promise<boolean> {
    if (expected.storagePath !== artifactGenerationPath(expected.key, expected.generation) ||
        !HASH.test(expected.manifestSha256)) throw new Error('invalid artifact invalidation')
    return this.transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [expected.key])
      const row = rows[0]
      if (!row || row.ready_generation === null || integer(row.ready_generation) !== expected.generation ||
          row.manifest_sha256 !== expected.manifestSha256 || row.storage_path !== expected.storagePath) return false
      const [jobs] = await connection.execute<RowDataPacket[]>(
        'SELECT state FROM parse_jobs WHERE artifact_key = ? FOR UPDATE', [expected.key])
      await connection.execute(`UPDATE parse_artifacts SET state = ?, ready_generation = NULL,
        storage_path = NULL, manifest_sha256 = NULL, bytes = 0, unit_count = 0, error_code = 'artifact_corrupt'
        WHERE artifact_key = ?`, [jobs[0]?.state === 'building' ? 'building' : 'failed', expected.key])
      await connection.execute(`UPDATE parse_jobs SET state = 'failed', error_code = 'artifact_corrupt'
        WHERE artifact_key = ? AND state <> 'building'`, [expected.key])
      return true
    })
  }

  async hasFileReference(fileId: string): Promise<boolean> {
    if (!HASH.test(fileId)) throw new Error('invalid artifact source file')
    const [rows] = await this.db.pool.execute<RowDataPacket[]>(
      'SELECT artifact_key FROM parse_artifacts WHERE file_id = ? LIMIT 1', [fileId])
    return rows.length > 0
  }

  /** Select the ready generation and register its reader under the same artifact lock. */
  async pin(key: string, owner: string, durationMs = this.leaseMs): Promise<{
    lease: ArtifactReadLease; artifact: ReadyArtifact
  } | null> {
    if (!HASH.test(key) || !/^[a-zA-Z0-9._:-]{1,128}$/.test(owner)) throw new Error('invalid artifact reader')
    this.readDuration(durationMs)
    return this.transaction(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [key])
      if (!rows[0]) return null
      const artifact = this.ready(rows[0])
      if (!artifact) return null
      const now = await this.now(connection)
      const lease = { id: randomUUID(), key, generation: artifact.generation, owner, leaseUntil: now + durationMs }
      await connection.execute(`INSERT INTO parse_artifact_read_leases
        (id, artifact_key, generation, lease_owner, lease_until) VALUES (?, ?, ?, ?, ?)`,
        [lease.id, key, lease.generation, owner, lease.leaseUntil])
      await connection.execute('UPDATE parse_artifacts SET last_access_at = ? WHERE artifact_key = ?', [now, key])
      return { artifact, lease }
    })
  }

  private readDuration(durationMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 600_000)
      throw new Error('invalid artifact read lease duration')
  }

  private async withReadLease<T>(lease: ArtifactReadLease,
    work: (connection: PoolConnection, now: number, row: RowDataPacket) => Promise<T>): Promise<T | false> {
    if (!HASH.test(lease.key) || !Number.isSafeInteger(lease.generation) || lease.generation < 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(lease.id))
      throw new Error('invalid artifact read lease')
    return this.transaction(async (connection) => {
      // Publication, readers and future collection share this lock order.
      const [artifacts] = await connection.execute<RowDataPacket[]>(
        'SELECT artifact_key FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [lease.key])
      if (!artifacts.length) return false
      const [rows] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifact_read_leases WHERE id = ? FOR UPDATE', [lease.id])
      const row = rows[0]
      if (!row || row.artifact_key !== lease.key || integer(row.generation) !== lease.generation ||
          row.lease_owner !== lease.owner) return false
      return work(connection, await this.now(connection), row)
    })
  }

  /** Transfer an existing live generation dependency into a separately renewable token. */
  async forkRead(source: ArtifactReadLease, owner: string, durationMs = this.leaseMs): Promise<ArtifactReadLease | null> {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(owner)) throw new Error('invalid artifact reader')
    this.readDuration(durationMs)
    const result = await this.withReadLease(source, async (connection, now, row) => {
      if (integer(row.lease_until) <= now) {
        await connection.execute('DELETE FROM parse_artifact_read_leases WHERE id = ?', [source.id])
        return null
      }
      const lease = { id: randomUUID(), key: source.key, generation: source.generation,
        owner, leaseUntil: now + durationMs }
      await connection.execute(`INSERT INTO parse_artifact_read_leases
        (id, artifact_key, generation, lease_owner, lease_until) VALUES (?, ?, ?, ?, ?)`,
        [lease.id, lease.key, lease.generation, owner, lease.leaseUntil])
      await connection.execute('UPDATE parse_artifacts SET last_access_at = ? WHERE artifact_key = ?', [now, source.key])
      return lease
    })
    return result || null
  }

  renewRead(lease: ArtifactReadLease, durationMs = this.leaseMs): Promise<boolean> {
    this.readDuration(durationMs)
    return this.withReadLease(lease, async (connection, now, row) => {
      // Old-generation readers remain valid after a new ready pointer is published.
      // Expired tokens cannot recreate or revive a reader.
      if (integer(row.lease_until) <= now) {
        // Once observed expired, retire the token permanently (also across clock corrections).
        await connection.execute('DELETE FROM parse_artifact_read_leases WHERE id = ?', [lease.id])
        return false
      }
      await connection.execute('UPDATE parse_artifact_read_leases SET lease_until = ? WHERE id = ?',
        [now + durationMs, lease.id])
      await connection.execute('UPDATE parse_artifacts SET last_access_at = ? WHERE artifact_key = ?', [now, lease.key])
      return true
    })
  }

  releaseRead(lease: ArtifactReadLease): Promise<boolean> {
    return this.withReadLease(lease, async (connection) => {
      await connection.execute('DELETE FROM parse_artifact_read_leases WHERE id = ?', [lease.id])
      return true
    })
  }

  /**
   * Irreversibly authorize removing the pre-generation flat files for `key`.
   * A builder may still be reading them (legacy import), so any live build job
   * vetoes the archive. Returns the exact ready pointer the caller must prove
   * on disk before deleting the legacy copy.
   */
  authorizeFlatArchive(key: string): Promise<ReadyArtifact | null> {
    if (!HASH.test(key)) throw new Error('invalid artifact key')
    return this.transaction(async (connection) => {
      const [artifacts] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [key])
      const artifact = artifacts[0]
      if (!artifact) return null
      // Same artifact -> job -> readers lock order as publication/retirement.
      const [jobs] = await connection.execute<RowDataPacket[]>(
        'SELECT state FROM parse_jobs WHERE artifact_key = ? FOR UPDATE', [key])
      if (jobs.some((job) => job.state === 'building')) return null
      if (artifact.state !== 'ready') return null
      const ready = this.ready(artifact)
      if (!ready) return null
      const [retired] = await connection.execute<RowDataPacket[]>(
        'SELECT generation FROM parse_artifact_retirements WHERE artifact_key = ? AND generation = ? FOR UPDATE',
        [key, ready.generation])
      if (retired.length) return null
      const now = await this.now(connection)
      await connection.execute(`INSERT INTO parse_artifact_flat_archives
        (artifact_key, generation, manifest_sha256, archived_at) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE generation = ?, manifest_sha256 = ?, archived_at = ?`,
      [key, ready.generation, ready.manifestSha256, now,
        ready.generation, ready.manifestSha256, now])
      return ready
    })
  }

  /**
   * Final cleanup of an unreferenced directory row. The caller must have proved
   * the whole key directory is empty (no g-N, flat files or unknown children);
   * SQL independently fences readiness, live builders and live readers.
   * Compressing retirement/flat history and deleting the row releases the
   * source-file FK so TTL GC can finally reclaim a temporary upload, while the
   * tombstone preserves the generation high-water mark across rebuilding.
   */
  archiveArtifact(key: string, diskEmpty: boolean): Promise<ArtifactArchive | null> {
    if (!HASH.test(key)) throw new Error('invalid artifact key')
    if (!diskEmpty) return Promise.resolve(null)
    return this.transaction(async (connection) => {
      const [artifacts] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [key])
      const artifact = artifacts[0]
      if (!artifact || artifact.ready_generation !== null || artifact.state === 'building') return null
      // Same artifact -> job -> readers lock order as publication/retirement.
      const [jobs] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_jobs WHERE artifact_key = ? FOR UPDATE', [key])
      const now = await this.now(connection)
      if (jobs.some((job) => job.state === 'building' && integer(job.lease_until ?? 0) > now)) return null
      const [reads] = await connection.execute<RowDataPacket[]>(
        'SELECT id, lease_until FROM parse_artifact_read_leases WHERE artifact_key = ? FOR UPDATE', [key])
      const expired = reads.filter((reader) => integer(reader.lease_until) <= now)
      for (const reader of expired)
        await connection.execute('DELETE FROM parse_artifact_read_leases WHERE id = ?', [reader.id])
      if (reads.length !== expired.length) return null
      const [retirements] = await connection.execute<RowDataPacket[]>(
        'SELECT generation FROM parse_artifact_retirements WHERE artifact_key = ? FOR UPDATE', [key])
      const [flat] = await connection.execute<RowDataPacket[]>(
        'SELECT artifact_key FROM parse_artifact_flat_archives WHERE artifact_key = ? FOR UPDATE', [key])
      // RESTRICT children must be removed before the directory row can go.
      await connection.execute('DELETE FROM parse_artifact_retirements WHERE artifact_key = ?', [key])
      await connection.execute('DELETE FROM parse_artifact_flat_archives WHERE artifact_key = ?', [key])
      await connection.execute('DELETE FROM parse_jobs WHERE artifact_key = ?', [key])
      const summary: ArtifactArchive = { key, fileId: artifact.file_id,
        generation: integer(artifact.generation), retiredGenerations: retirements.length,
        flatArchived: flat.length > 0, archivedAt: now }
      await connection.execute(`INSERT INTO parse_artifact_archives
        (artifact_key, file_id, generation, retired_generations, flat_archived, archived_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE generation = VALUES(generation),
          retired_generations = VALUES(retired_generations), flat_archived = VALUES(flat_archived)`,
      [key, summary.fileId, summary.generation, summary.retiredGenerations,
        summary.flatArchived ? 1 : 0, summary.archivedAt])
      await connection.execute('DELETE FROM parse_artifacts WHERE artifact_key = ?', [key])
      return summary
    })
  }

  /** Irreversibly fence a generation before filesystem collection, not a transient can-delete check. */
  retireGeneration(key: string, generation: number): Promise<boolean> {
    artifactGenerationPath(key, generation)
    return this.transaction(async (connection) => {
      const [artifacts] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [key])
      const artifact = artifacts[0]
      if (!artifact || generation > integer(artifact.generation) ||
          (artifact.ready_generation !== null && integer(artifact.ready_generation) === generation)) return false
      const [jobs] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_jobs WHERE artifact_key = ? FOR UPDATE', [key])
      const [readers] = await connection.execute<RowDataPacket[]>(
        'SELECT lease_until FROM parse_artifact_read_leases WHERE artifact_key = ? AND generation = ? FOR UPDATE',
        [key, generation])
      const now = await this.now(connection)
      const job = jobs[0]
      const sameJob = job && integer(job.generation) === generation
      if ((sameJob && job.state === 'building' && integer(job.lease_until) > now) ||
          readers.some((reader) => integer(reader.lease_until) > now)) return false
      await connection.execute('DELETE FROM parse_artifact_read_leases WHERE artifact_key = ? AND generation = ?',
        [key, generation])
      if (sameJob && job.state === 'building') {
        // Expired build tokens cannot revive after clock corrections or delayed renewals.
        await connection.execute(`UPDATE parse_jobs SET state = 'failed', lease_owner = NULL,
          lease_until = NULL, error_code = 'generation_retired' WHERE artifact_key = ?`, [key])
        await connection.execute(`UPDATE parse_artifacts SET state = ?, error_code = 'generation_retired'
          WHERE artifact_key = ?`, [artifact.ready_generation === null ? 'failed' : 'ready', key])
      }
      await connection.execute(`INSERT INTO parse_artifact_retirements (artifact_key, generation, retired_at)
        VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE retired_at = retired_at`, [key, generation, now])
      return true
    })
  }

  async claim(identity: ArtifactIdentity, owner: string, rebuild = false): Promise<ArtifactClaim> {
    const key = artifactKey(identity)
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(owner)) throw new Error('invalid lease owner')
    return this.transaction(async (connection) => {
      // A tombstone keeps the generation counter monotonic even after its
      // directory row was archived and the source file was reclaimed. Existing
      // rows keep their own counter (ON DUPLICATE KEY UPDATE is a no-op).
      await connection.execute(`INSERT INTO parse_artifacts
        (artifact_key, file_id, identity, state, generation, last_access_at)
        VALUES (?, ?, ?, 'building',
          COALESCE((SELECT generation FROM parse_artifact_archives WHERE artifact_key = ?), 0), 0)
        ON DUPLICATE KEY UPDATE artifact_key = artifact_key`,
      [key, identity.fileId, canonicalJson(identity), key])
      const [artifacts] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [key])
      const artifact = artifacts[0]
      if (artifactKey(typeof artifact.identity === 'string' ? JSON.parse(artifact.identity) : artifact.identity) !== key)
        throw new Error('catalog identity mismatch')
      const [jobs] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_jobs WHERE artifact_key = ? FOR UPDATE', [key])
      const now = await this.now(connection)
      const job = jobs[0]
      const ready = this.ready(artifact)
      if (ready && !rebuild) return { kind: 'ready', artifact: ready }
      if (job?.state === 'building' && integer(job.lease_until) > now)
        return { kind: 'busy', leaseUntil: integer(job.lease_until) }
      const generation = integer(artifact.generation) + 1
      if (!Number.isSafeInteger(generation)) throw new Error('artifact generation exhausted')
      const jobId = job?.job_id ?? randomUUID()
      const leaseUntil = now + this.leaseMs
      await connection.execute(`UPDATE parse_artifacts SET generation = ?, state = ?, error_code = NULL
        WHERE artifact_key = ?`, [generation, ready ? 'ready' : 'building', key])
      await connection.execute(`INSERT INTO parse_jobs
        (job_id, artifact_key, state, attempt, generation, lease_owner, lease_until)
        VALUES (?, ?, 'building', 1, ?, ?, ?) ON DUPLICATE KEY UPDATE
        state = 'building', attempt = attempt + 1, generation = ?, lease_owner = ?, lease_until = ?,
        progress = 0, error_code = NULL`, [jobId, key, generation, owner, leaseUntil, generation, owner, leaseUntil])
      return { kind: 'acquired', lease: { key, jobId, owner, generation, leaseUntil } }
    })
  }

  private async withLease(lease: ArtifactLease,
    work: (connection: PoolConnection, artifact: RowDataPacket, now: number) => Promise<void>): Promise<boolean> {
    if (!HASH.test(lease.key)) throw new Error('invalid lease key')
    return this.transaction(async (connection) => {
      // All mutations acquire locks in the same artifact -> job order.
      const [artifacts] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_artifacts WHERE artifact_key = ? FOR UPDATE', [lease.key])
      const [jobs] = await connection.execute<RowDataPacket[]>(
        'SELECT * FROM parse_jobs WHERE artifact_key = ? FOR UPDATE', [lease.key])
      const now = await this.now(connection)
      const job = jobs[0]
      if (!artifacts[0] || !job || job.state !== 'building' || job.job_id !== lease.jobId ||
          job.lease_owner !== lease.owner || integer(job.generation) !== lease.generation ||
          integer(artifacts[0].generation) !== lease.generation || integer(job.lease_until) <= now) return false
      const [retired] = await connection.execute<RowDataPacket[]>(
        'SELECT generation FROM parse_artifact_retirements WHERE artifact_key = ? AND generation = ? FOR UPDATE',
        [lease.key, lease.generation])
      if (retired.length) return false
      await work(connection, artifacts[0], now)
      return true
    })
  }

  renew(lease: ArtifactLease): Promise<boolean> {
    return this.withLease(lease, async (connection, _artifact, now) => {
      await connection.execute('UPDATE parse_jobs SET lease_until = ? WHERE artifact_key = ?',
        [now + this.leaseMs, lease.key])
    })
  }

  complete(lease: ArtifactLease, info: { bytes: number; unitCount: number; manifestSha256: string }): Promise<boolean> {
    integer(info.bytes)
    integer(info.unitCount)
    if (info.unitCount > 0xffff_ffff || !HASH.test(info.manifestSha256)) throw new Error('invalid artifact summary')
    const path = artifactGenerationPath(lease.key, lease.generation)
    return this.withLease(lease, async (connection, _artifact, now) => {
      await connection.execute(`UPDATE parse_artifacts SET state = 'ready', ready_generation = ?,
        storage_path = ?, manifest_sha256 = ?, bytes = ?, unit_count = ?, last_access_at = ?, error_code = NULL
        WHERE artifact_key = ?`, [lease.generation, path, info.manifestSha256, info.bytes, info.unitCount, now, lease.key])
      await connection.execute(`UPDATE parse_jobs SET state = 'ready', lease_owner = NULL,
        lease_until = NULL, progress = 100 WHERE artifact_key = ?`, [lease.key])
    })
  }

  fail(lease: ArtifactLease, errorCode: string): Promise<boolean> {
    if (!/^[a-z0-9_]{1,64}$/.test(errorCode)) throw new Error('invalid artifact error code')
    return this.withLease(lease, async (connection, artifact) => {
      await connection.execute(`UPDATE parse_jobs SET state = 'failed', lease_owner = NULL,
        lease_until = NULL, error_code = ? WHERE artifact_key = ?`, [errorCode, lease.key])
      await connection.execute(`UPDATE parse_artifacts SET state = ?, error_code = ? WHERE artifact_key = ?`,
        [artifact.ready_generation === null ? 'failed' : 'ready', errorCode, lease.key])
    })
  }
}
