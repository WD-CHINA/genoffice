import { drainCleanups } from './helpers/cleanup'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { MysqlArtifactCatalog, type ReadyArtifact } from '../src/artifact-catalog'
import { ArtifactGenerations } from '../src/artifact-generations'
import type { ArtifactIdentity } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

// Explicit opt-in socket must refer to an isolated test instance, never a production server.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

interface ArtifactRow extends RowDataPacket {
  artifact_key: string
  file_id: string
  identity: ArtifactIdentity | string
  state: string
  generation: number
  ready_generation: number | null
  storage_path: string
  manifest_sha256: string
  bytes: number
  unit_count: number
}

describe.skipIf(!socketPath)('generation high-water archive over real MySQL', () => {
  async function setup() {
    const database = `genoffice_archive_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'archive-mysql-'))
    const config = {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database,
      socketPath,
    }
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const server = await createParseServer({
      dataDir,
      mysql: config,
      artifactBackend: 'catalog',
      token: 'secret',
      parserFingerprint: 'archive-mysql-test',
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
    const pool = server.db!.pool
    const [rows] = await pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE file_id = ?',
      [fileId],
    )
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(Number(row.ready_generation)).toBe(1)
    const ready: ReadyArtifact = {
      key: row.artifact_key,
      generation: Number(row.ready_generation),
      storagePath: row.storage_path,
      manifestSha256: row.manifest_sha256,
      bytes: Number(row.bytes),
      unitCount: Number(row.unit_count),
    }
    const identity =
      typeof row.identity === 'string'
        ? (JSON.parse(row.identity) as ArtifactIdentity)
        : row.identity
    const catalog = new MysqlArtifactCatalog(server.db!)
    const count = async (table: string) =>
      (
        await pool.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE artifact_key = ?`,
          [row.artifact_key],
        )
      )[0][0].n as number
    const keyDirectory = join(dataDir, 'artifacts', row.artifact_key.slice(0, 2), row.artifact_key)
    // Release the view's read lease deterministically before driving archival.
    await request(`/v1/sessions/${sessionId}`, { method: 'DELETE' })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const [leases] = await pool.query<RowDataPacket[]>(
        'SELECT id FROM parse_artifact_read_leases WHERE artifact_key = ?',
        [row.artifact_key],
      )
      if (!leases.length) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return {
      server,
      dataDir,
      request,
      pool,
      sessionId,
      fileId,
      row,
      ready,
      identity,
      catalog,
      count,
      keyDirectory,
    }
  }

  async function addHistory(h: Awaited<ReturnType<typeof setup>>) {
    await h.pool.execute(
      `INSERT INTO parse_artifact_retirements
      (artifact_key, generation, retired_at) VALUES (?, ?, ?)`,
      [h.row.artifact_key, 2, Date.now()],
    )
    await h.pool.execute(
      `INSERT INTO parse_artifact_retirements
      (artifact_key, generation, retired_at) VALUES (?, ?, ?)`,
      [h.row.artifact_key, 3, Date.now()],
    )
    await h.pool.execute(
      `INSERT INTO parse_artifact_flat_archives
      (artifact_key, generation, manifest_sha256, archived_at) VALUES (?, ?, ?, ?)`,
      [h.row.artifact_key, 1, h.ready.manifestSha256, Date.now()],
    )
    await h.pool.execute(
      `INSERT INTO parse_artifact_read_leases
      (id, artifact_key, generation, lease_owner, lease_until) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), h.row.artifact_key, 1, 'expired-reader', Date.now() - 1000],
    )
  }

  it('fences readiness, builders and readers, then compresses history into a tombstone', async () => {
    const h = await setup()
    const key = h.row.artifact_key
    await addHistory(h)
    // A live ready pointer, a non-empty disk root and an active reader all veto.
    expect(await h.catalog.archiveArtifact(key, true)).toBeNull()
    expect(await h.catalog.archiveArtifact(key, false)).toBeNull()
    expect(await h.catalog.invalidateReady(h.ready)).toBe(true)
    await h.pool.execute(
      `INSERT INTO parse_artifact_read_leases
      (id, artifact_key, generation, lease_owner, lease_until) VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), key, 1, 'live-reader', Date.now() + 60_000],
    )
    expect(await h.catalog.archiveArtifact(key, true)).toBeNull()
    await h.pool.execute('DELETE FROM parse_artifact_read_leases WHERE lease_owner = ?', [
      'live-reader',
    ])
    await h.pool.execute(
      `UPDATE parse_jobs SET state = 'building', lease_until = ?
      WHERE artifact_key = ?`,
      [Date.now() + 60_000, key],
    )
    expect(await h.catalog.archiveArtifact(key, true)).toBeNull()
    await h.pool.execute(
      `UPDATE parse_jobs SET state = 'failed', lease_until = NULL
      WHERE artifact_key = ?`,
      [key],
    )

    const summary = await h.catalog.archiveArtifact(key, true)
    expect(summary).toMatchObject({
      key,
      fileId: h.fileId,
      generation: 1,
      retiredGenerations: 2,
      flatArchived: true,
    })
    expect(summary!.archivedAt).toBeGreaterThan(0)
    expect(await h.count('parse_artifacts')).toBe(0)
    expect(await h.count('parse_artifact_retirements')).toBe(0)
    expect(await h.count('parse_artifact_flat_archives')).toBe(0)
    expect(await h.count('parse_artifact_read_leases')).toBe(0)
    expect(await h.count('parse_jobs')).toBe(0)
    const [tombstones] = await h.pool.query<RowDataPacket[]>(
      'SELECT * FROM parse_artifact_archives WHERE artifact_key = ?',
      [key],
    )
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]).toMatchObject({
      file_id: h.fileId,
      generation: 1,
      retired_generations: 2,
      flat_archived: 1,
    })
    expect(await h.catalog.hasFileReference(h.fileId)).toBe(false)
    expect(await h.catalog.archiveArtifact(key, true)).toBeNull()
  }, 25_000)

  it('restores the generation high-water mark when the same artifact is rebuilt', async () => {
    const h = await setup()
    await addHistory(h)
    expect(await h.catalog.invalidateReady(h.ready)).toBe(true)
    expect(await h.catalog.archiveArtifact(h.row.artifact_key, true)).toMatchObject({
      generation: 1,
    })
    const claimed = await h.catalog.claim(h.identity, 'rebuild-owner')
    expect(claimed.kind).toBe('acquired')
    if (claimed.kind !== 'acquired') return
    // Never reuses g-1: the tombstone carries the retired high-water mark.
    expect(claimed.lease.generation).toBe(2)
    expect(
      await h.catalog.complete(claimed.lease, {
        bytes: h.ready.bytes,
        unitCount: h.ready.unitCount,
        manifestSha256: h.ready.manifestSha256,
      }),
    ).toBe(true)
    const [rows] = await h.pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE artifact_key = ?',
      [h.row.artifact_key],
    )
    expect(Number(rows[0].ready_generation)).toBe(2)
    expect(rows[0].storage_path).toBe(
      `artifacts/${h.row.artifact_key.slice(0, 2)}/${h.row.artifact_key}/g-2`,
    )
    expect(await h.catalog.hasFileReference(h.fileId)).toBe(true)
  }, 25_000)

  it('deletes only an empty key root after the SQL transaction commits', async () => {
    const h = await setup()
    const disk = new ArtifactGenerations(h.dataDir)
    expect(await h.catalog.invalidateReady(h.ready)).toBe(true)
    // A surviving generation makes the root ineligible.
    expect(await disk.collectEmptyKey(h.row.artifact_key, h.catalog)).toBeNull()
    expect(await h.count('parse_artifacts')).toBe(1)
    expect(await readdir(h.keyDirectory)).toContain('g-1')

    await rm(join(h.dataDir, h.ready.storagePath), { recursive: true, force: true })
    const summary = await disk.collectEmptyKey(h.row.artifact_key, h.catalog)
    expect(summary).toMatchObject({
      key: h.row.artifact_key,
      generation: 1,
      retiredGenerations: 0,
      flatArchived: false,
    })
    await expect(stat(h.keyDirectory)).rejects.toThrow()
    expect(await h.count('parse_artifacts')).toBe(0)
    expect(await h.catalog.hasFileReference(h.fileId)).toBe(false)
    expect(await disk.collectEmptyKey(h.row.artifact_key, h.catalog)).toBeNull()
  }, 25_000)

  it('background archiving releases the source file for TTL collection', async () => {
    const h = await setup()
    expect(await h.catalog.invalidateReady(h.ready)).toBe(true)
    await rm(join(h.dataDir, h.ready.storagePath), { recursive: true, force: true })
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(h.keyDirectory, old, old)
    await mkdir(join(h.dataDir, 'artifacts', h.row.artifact_key.slice(0, 2)), { recursive: true })
    await utimes(join(h.dataDir, 'artifacts', h.row.artifact_key.slice(0, 2)), old, old)

    const health = async () =>
      (await (await h.request('/v1/health')).json()) as {
        errors: number
        artifacts: { archivedKeys: number; archivedRetiredRows: number }
      }
    await h.server.gc()
    let latest = await health()
    const deadline = Date.now() + 10_000
    while (latest.artifacts.archivedKeys < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      latest = await health()
    }
    expect(latest.artifacts.archivedKeys).toBe(1)
    expect(latest.artifacts.archivedRetiredRows).toBe(0)
    expect(latest.errors).toBe(0)
    await expect(stat(h.keyDirectory)).rejects.toThrow()
    expect(await h.count('parse_artifacts')).toBe(0)
    expect(await h.catalog.hasFileReference(h.fileId)).toBe(false)

    // With the directory row gone, the FK no longer pins the original upload.
    const files = await h.server.store.list()
    vi.spyOn(h.server.store, 'list').mockResolvedValueOnce(
      files.map((file) => ({
        ...file,
        createdAt: '2000-01-01T00:00:00.000Z',
      })),
    )
    await h.server.gc()
    expect(await h.server.store.stat(h.fileId)).toBeNull()
  }, 30_000)
})
