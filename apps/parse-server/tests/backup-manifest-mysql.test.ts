import { drainCleanups } from './helpers/cleanup'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import type { ReadyArtifact } from '../src/artifact-catalog'
import {
  BackupConcurrencyError,
  BackupManifestError,
  createBackupManifest,
  mysqlBackupCatalogSource,
  verifyRestore,
  type BackupCatalogSource,
  type BackupManifest,
} from '../src/backup-manifest'
import { MysqlDatabase, type MysqlConfig } from '../src/mysql'
import { createParseServer, type ParseServer } from '../src/server'

// Explicit opt-in socket must refer to an isolated test instance, never production.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

interface ArtifactRow extends RowDataPacket {
  artifact_key: string
  ready_generation: number | null
  storage_path: string
  manifest_sha256: string
  bytes: number
  unit_count: number
}

describe.skipIf(!socketPath)('backup manifest and restore drill over real MySQL', () => {
  async function setup() {
    const database = `genoffice_backup_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'backup-mysql-'))
    const config: MysqlConfig = {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database,
      socketPath,
    }
    const servers: ParseServer[] = []
    const pools: MysqlDatabase[] = []
    cleanups.push(async () => {
      for (const server of servers) await server.close().catch(() => undefined)
      for (const pool of pools) await pool.close().catch(() => undefined)
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const server = await createParseServer({
      dataDir,
      mysql: config,
      artifactBackend: 'catalog',
      token: 'secret',
      parserFingerprint: 'backup-mysql-test',
    })
    servers.push(server)
    const request = (path: string, init?: RequestInit) =>
      fetch(server.url + path, {
        ...init,
        headers: { Authorization: 'Bearer secret', ...init?.headers },
      })
    const uploaded = await request('/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const opened = await request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(opened.status, await opened.clone().text()).toBe(201)
    const { sessionId } = (await opened.json()) as { sessionId: string }
    // The drill uses its own pool, exactly like an operator's backup tool.
    const drillDb = new MysqlDatabase(config)
    pools.push(drillDb)
    const [rows] = await drillDb.pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE file_id = ?',
      [fileId],
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].ready_generation)).toBe(1)
    const row = rows[0]
    const ready: ReadyArtifact = {
      key: row.artifact_key,
      generation: Number(row.ready_generation),
      storagePath: row.storage_path,
      manifestSha256: row.manifest_sha256,
      bytes: Number(row.bytes),
      unitCount: Number(row.unit_count),
    }
    return { server, dataDir, config, request, fileId, sessionId, drillDb, servers, ready }
  }

  async function readyGeneration(h: Awaited<ReturnType<typeof setup>>): Promise<number | null> {
    const [rows] = await h.drillDb.pool.query<RowDataPacket[]>(
      'SELECT ready_generation FROM parse_artifacts WHERE artifact_key = ?',
      [h.ready.key],
    )
    return rows[0]?.ready_generation === null || rows[0]?.ready_generation === undefined
      ? null
      : Number(rows[0].ready_generation)
  }

  it('snapshots SQL rows, source bytes and generations, then gates startup on a clean drill', async () => {
    const h = await setup()
    const manifest = await createBackupManifest({ dataDir: h.dataDir, db: h.drillDb })
    expect(manifest.catalog.backend).toBe('mysql')
    expect(manifest.catalog.files.map((file) => file.fileId)).toContain(h.fileId)
    expect(manifest.catalog.artifacts.some((row) => row.ready?.key === h.ready.key)).toBe(true)
    const paths = manifest.entries.map((entry) => entry.path)
    expect(paths).toContain(`files/${h.fileId.slice(0, 2)}/${h.fileId}`)
    expect(paths).toContain(`meta/${h.fileId}.json`)
    expect(paths).toContain(`${h.ready.storagePath}/manifest.json`)
    expect(paths).toContain(`${h.ready.storagePath}/units.bin`)

    const report = await verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest, deep: true })
    expect(report.ok).toBe(true)
    expect(report.readyAllowed).toBe(true)
    expect(report.readyVerified).toContain(h.ready.key)
    expect(report.counts.readyPointers).toBeGreaterThanOrEqual(1)
    expect(report.errors).toEqual([])

    await h.request(`/v1/sessions/${h.sessionId}`, { method: 'DELETE' })
    await h.server.close()
    const recovered = await createParseServer({
      dataDir: h.dataDir,
      mysql: h.config,
      artifactBackend: 'catalog',
      token: 'secret',
      parserFingerprint: 'backup-mysql-test',
      restoreCheck: { manifest, deep: true },
    })
    h.servers.push(recovered)
    const health = (await (await fetch(recovered.url + '/v1/health')).json()) as {
      restore: { ok: boolean; readyAllowed: boolean; errors: number; digest: string }
    }
    expect(health.restore).toMatchObject({
      ok: true,
      readyAllowed: true,
      errors: 0,
      digest: manifest.digest,
    })
  }, 40_000)

  it('withdraws a damaged ready generation and rebuilds it on the next request', async () => {
    const h = await setup()
    const manifest = await createBackupManifest({ dataDir: h.dataDir, db: h.drillDb })
    await rm(join(h.dataDir, h.ready.storagePath, 'units.bin'))
    const report = await verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest })
    expect(report.blockedReady).toHaveLength(1)
    expect(report.blockedReady[0]).toMatchObject({ key: h.ready.key, reconciled: true })
    expect(report.ok).toBe(true)
    expect(report.readyAllowed).toBe(true)
    expect(report.warnings.some((issue) => issue.code === 'ready_withdrawn')).toBe(true)
    expect(await readyGeneration(h)).toBeNull()

    const waiting = await h.request('/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: h.fileId }),
    })
    const pending = (await waiting.json()) as { sessionId: string; state?: string }
    let state = pending.state ?? 'queued'
    for (let attempt = 0; attempt < 150 && state !== 'ready'; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      const status = (await (await h.request(`/v2/sessions/${pending.sessionId}`)).json()) as {
        state: string
      }
      state = status.state
      expect(state).not.toBe('failed')
    }
    expect(state).toBe('ready')
    expect(await readyGeneration(h)).toBe(2)
    expect((await h.request(`/v2/sessions/${pending.sessionId}/units/0`)).status).toBe(200)
  }, 40_000)

  it('fails closed on source loss and refuses to start with an unverifiable restore', async () => {
    const h = await setup()
    const manifest = await createBackupManifest({ dataDir: h.dataDir, db: h.drillDb })
    await rm(join(h.dataDir, 'files', h.fileId.slice(0, 2), h.fileId))
    const report = await verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest })
    expect(report.ok).toBe(false)
    expect(report.readyAllowed).toBe(false)
    expect(report.errors.some((issue) => issue.code === 'source_missing')).toBe(true)
    await expect(
      createParseServer({
        dataDir: h.dataDir,
        mysql: h.config,
        artifactBackend: 'catalog',
        token: 'secret',
        parserFingerprint: 'backup-mysql-test',
        restoreCheck: { manifest },
      }),
    ).rejects.toThrow(/restore check failed/)
  }, 40_000)

  it('refuses a snapshot when a concurrent writer changes the catalog', async () => {
    const h = await setup()
    const base = mysqlBackupCatalogSource(h.drillDb)
    const extra = createHash('sha256').update(randomUUID()).digest('hex')
    const hooked: BackupCatalogSource = {
      ...base,
      open: async () => {
        const boundary = await base.open()
        // Committed OUTSIDE the consistent-snapshot connection; recheck must see it.
        await h.drillDb.pool.execute(
          `INSERT INTO parse_files
          (file_id, sha256, size, format, created_at) VALUES (?, ?, ?, ?, ?)`,
          [extra, extra, 1, 'pptx', new Date().toISOString()],
        )
        return boundary
      },
    }
    await expect(
      createBackupManifest({ dataDir: h.dataDir, source: hooked }),
    ).rejects.toBeInstanceOf(BackupConcurrencyError)
    await h.drillDb.pool.execute('DELETE FROM parse_files WHERE file_id = ?', [extra])
  }, 40_000)

  it('protects generation tombstones and rejects a tampered manifest digest', async () => {
    const h = await setup()
    const tombstone = createHash('sha256').update(randomUUID()).digest('hex')
    await h.drillDb.pool.execute(
      `INSERT INTO parse_artifact_archives
      (artifact_key, file_id, generation, retired_generations, flat_archived, archived_at)
      VALUES (?, ?, ?, 0, 0, ?)`,
      [tombstone, h.fileId, 9, Date.now()],
    )
    const manifest = await createBackupManifest({ dataDir: h.dataDir, db: h.drillDb })
    expect(manifest.catalog.archives.some((row) => row.key === tombstone)).toBe(true)
    await h.drillDb.pool.execute('DELETE FROM parse_artifact_archives WHERE artifact_key = ?', [
      tombstone,
    ])
    const report = await verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest })
    expect(report.ok).toBe(false)
    expect(report.errors.some((issue) => issue.code === 'tombstone_lost')).toBe(true)
    const altered = { ...manifest, digest: 'f'.repeat(64) } as BackupManifest
    await expect(
      verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest: altered }),
    ).rejects.toBeInstanceOf(BackupManifestError)
  }, 40_000)

  it('a deep drill detects a frame corrupted before the snapshot and fences real SQL readiness', async () => {
    const h = await setup()
    const dataPath = join(h.dataDir, h.ready.storagePath, 'units.bin')
    const { readFile, writeFile } = await import('node:fs/promises')
    const damaged = Buffer.from(await readFile(dataPath))
    damaged[damaged.length - 1] ^= 0xff
    await writeFile(dataPath, damaged)
    const manifest = await createBackupManifest({ dataDir: h.dataDir, db: h.drillDb })
    const shallow = await verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest })
    expect(shallow.readyVerified).toContain(h.ready.key)
    const deep = await verifyRestore({ dataDir: h.dataDir, db: h.drillDb, manifest, deep: true })
    expect(deep.blockedReady.some((entry) => entry.key === h.ready.key)).toBe(true)
    expect(await readyGeneration(h)).toBeNull()
  }, 40_000)
})
