import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MysqlArtifactCatalog,
  type ArtifactClaim,
  type ReadyArtifact,
} from '../src/artifact-catalog'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactReadyEviction, type ReadyEvictionOptions } from '../src/artifact-ready-eviction'
import { MysqlDatabase } from '../src/mysql'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import type { ArtifactIdentity } from '../src/artifact-store'

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
  error_code: string | null
}

describe.skipIf(!socketPath)('pressure ready eviction over real MySQL', () => {
  async function setup(options: Partial<ParseServerOptions> = {}) {
    const database = `genoffice_evict_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'ready-eviction-mysql-'))
    const config = {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database,
      socketPath,
    }
    const servers: ParseServer[] = []
    const extraDatabases: MysqlDatabase[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await Promise.all(extraDatabases.map((db) => db.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const server = await createParseServer({
      dataDir,
      mysql: config,
      artifactBackend: 'catalog',
      token: 'secret',
      parserFingerprint: 'ready-eviction-mysql-test',
      readyEvictionIdleMs: 0,
      ...options,
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
    expect(uploaded.status, await uploaded.clone().text()).toBe(201)
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
    return {
      server,
      dataDir,
      config,
      request,
      pool,
      sessionId,
      fileId,
      row,
      ready,
      identity,
      catalog,
      extraDatabases,
    }
  }

  type Harness = Awaited<ReturnType<typeof setup>>

  function evictionFor(h: Harness, extra: Partial<ReadyEvictionOptions> = {}) {
    return new ArtifactReadyEviction(
      new MysqlArtifactCatalog(h.server.db!),
      new ArtifactGenerations(h.dataDir),
      {
        idleMs: 0,
        sourceExists: async (fileId) => !!(await h.server.store.pathOf(fileId)),
        ...extra,
      },
    )
  }

  async function releaseReaders(h: Harness): Promise<void> {
    await h.request(`/v1/sessions/${h.sessionId}`, { method: 'DELETE' })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const [leases] = await h.pool.query<RowDataPacket[]>(
        'SELECT id FROM parse_artifact_read_leases WHERE artifact_key = ?',
        [h.row.artifact_key],
      )
      if (!leases.length) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('read lease was not released')
  }

  it('withdraws and collects a rebuildable ready generation while retaining the source', async () => {
    const h = await setup()
    await releaseReaders(h)
    const generationDir = join(h.dataDir, h.ready.storagePath)
    expect((await stat(generationDir)).isDirectory()).toBe(true)
    const eviction = evictionFor(h)
    eviction.request(1)
    const result = await eviction.run()
    expect(result).toMatchObject({ withdrawn: 1, collected: 1, failed: 0, protected: 0 })
    expect(result.bytesFreed).toBeGreaterThan(0)
    await expect(stat(generationDir)).rejects.toMatchObject({ code: 'ENOENT' })
    const [after] = await h.pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE artifact_key = ?',
      [h.ready.key],
    )
    expect(after[0]).toMatchObject({
      state: 'reclaimed',
      error_code: 'artifact_reclaimed',
      bytes: 0,
      unit_count: 0,
    })
    expect(after[0].ready_generation).toBeNull()
    expect(Number(after[0].generation)).toBe(1) // high-water mark survives withdrawal
    const [retirements] = await h.pool.query<RowDataPacket[]>(
      'SELECT generation FROM parse_artifact_retirements WHERE artifact_key = ?',
      [h.ready.key],
    )
    expect(retirements).toHaveLength(1)
    expect(Number(retirements[0].generation)).toBe(1)
    // The source document, its catalogue row and the library are untouched.
    expect(await h.server.store.pathOf(h.fileId)).not.toBeNull()
    const [files] = await h.pool.query<RowDataPacket[]>(
      'SELECT file_id FROM parse_files WHERE file_id = ?',
      [h.fileId],
    )
    expect(files).toHaveLength(1)
    const claim: ArtifactClaim = await h.catalog.claim(h.identity, 'rebuild')
    expect(claim.kind).toBe('acquired')
    if (claim.kind === 'acquired') expect(claim.lease.generation).toBe(2)
  })

  it('fences live readers, respects the idle window and rejects stale pointers', async () => {
    const h = await setup()
    expect(await h.catalog.listReadyEvictionCandidates(8, 0)).toEqual([])
    const eviction = evictionFor(h)
    eviction.request(1)
    expect(await eviction.run()).toMatchObject({ examined: 0, withdrawn: 0 })
    await releaseReaders(h)
    const candidates = await h.catalog.listReadyEvictionCandidates(8, 0)
    expect(candidates).toHaveLength(1)
    expect(candidates[0].artifact.key).toBe(h.ready.key)
    expect(candidates[0].fileId).toBe(h.fileId)
    expect(await h.catalog.listReadyEvictionCandidates(8, 60_000)).toEqual([])
    expect(await h.catalog.withdrawReady({ ...h.ready, manifestSha256: 'd'.repeat(64) })).toBe(
      false,
    )
    const [after] = await h.pool.query<ArtifactRow[]>(
      'SELECT state, ready_generation FROM parse_artifacts WHERE artifact_key = ?',
      [h.ready.key],
    )
    expect(after[0].state).toBe('ready')
    expect(Number(after[0].ready_generation)).toBe(1)
  })

  it('vetoes withdrawal while another writer owns a live build lease', async () => {
    const h = await setup()
    await releaseReaders(h)
    const claim = await h.catalog.claim(h.identity, 'builder', true)
    expect(claim.kind).toBe('acquired')
    expect(await h.catalog.listReadyEvictionCandidates(8, 0)).toEqual([])
    expect(await h.catalog.withdrawReady(h.ready)).toBe(false)
    await h.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [
      h.ready.key,
    ])
    expect(await h.catalog.listReadyEvictionCandidates(8, 0)).toHaveLength(1)
  })

  it('lets racing instances withdraw and collect the same generation only once', async () => {
    const h = await setup()
    await releaseReaders(h)
    const second = new MysqlDatabase(h.config)
    await second.init()
    h.extraDatabases.push(second)
    const build = (catalog: MysqlArtifactCatalog) =>
      new ArtifactReadyEviction(catalog, new ArtifactGenerations(h.dataDir), {
        idleMs: 0,
        sourceExists: async (fileId) => !!(await h.server.store.pathOf(fileId)),
      })
    const first = build(new MysqlArtifactCatalog(h.server.db!))
    const other = build(new MysqlArtifactCatalog(second))
    first.request(1)
    other.request(1)
    const [a, b] = await Promise.all([first.run(), other.run()])
    expect(a.withdrawn + b.withdrawn).toBe(1)
    expect(a.collected + b.collected).toBe(1)
    expect(a.bytesFreed + b.bytesFreed).toBeGreaterThan(0)
    const [retirements] = await h.pool.query<RowDataPacket[]>(
      'SELECT generation FROM parse_artifact_retirements WHERE artifact_key = ?',
      [h.ready.key],
    )
    expect(retirements).toHaveLength(1)
    await expect(stat(join(h.dataDir, h.ready.storagePath))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('never withdraws a cache once its source bytes have disappeared', async () => {
    const h = await setup()
    await releaseReaders(h)
    const source = await h.server.store.pathOf(h.fileId)
    expect(source).not.toBeNull()
    await rm(source!)
    expect(await h.catalog.listReadyEvictionCandidates(8, 0)).toHaveLength(1)
    const eviction = evictionFor(h)
    eviction.request(1)
    expect(await eviction.run()).toMatchObject({
      examined: 1,
      withdrawn: 0,
      collected: 0,
      protected: 1,
    })
    const [after] = await h.pool.query<ArtifactRow[]>(
      'SELECT state, ready_generation FROM parse_artifacts WHERE artifact_key = ?',
      [h.ready.key],
    )
    expect(after[0].state).toBe('ready')
    expect((await stat(join(h.dataDir, h.ready.storagePath))).isDirectory()).toBe(true)
  })

  it('reclaims through the real high-water GC path and rebuilds on the next open', async () => {
    const h = await setup({ storageHighWaterPercent: 2, storageLowWaterPercent: 1 })
    await releaseReaders(h)
    // A real (sparse) 600 MiB source pushes the shared budget past its 2% mark.
    // It is a newly created, unparsed upload: TTL GC must not delete it.
    const bigId = 'c'.repeat(64)
    const bigSize = 600 * 1024 * 1024
    const bigPath = join(h.dataDir, 'files', bigId.slice(0, 2), bigId)
    await mkdir(join(h.dataDir, 'files', bigId.slice(0, 2)), { recursive: true })
    const handle = await open(bigPath, 'w')
    await handle.truncate(bigSize)
    await handle.close()
    await h.pool.execute(
      `INSERT INTO parse_files
      (file_id, sha256, size, format, created_at) VALUES (?, ?, ?, 'pptx', ?)`,
      [bigId, bigId, bigSize, new Date().toISOString()],
    )
    const health = async () =>
      (await (await h.request('/v1/health')).json()) as {
        errors: number
        readyEviction: { totalWithdrawn: number; pendingBytes: number; rounds: number } | null
        maintenance: { generationCollection?: { lastResult?: { readyWithdrawn?: number } } }
      }
    expect((await health()).readyEviction).not.toBeNull()
    await h.server.gc()
    let latest = await health()
    const deadline = Date.now() + 10_000
    while (latest.readyEviction!.totalWithdrawn < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      latest = await health()
    }
    expect(latest.readyEviction!.totalWithdrawn).toBe(1)
    expect(latest.readyEviction!.rounds).toBeGreaterThanOrEqual(1)
    expect(latest.errors).toBe(0)
    await expect(stat(join(h.dataDir, h.ready.storagePath))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await h.server.store.pathOf(h.fileId)).not.toBeNull()
    expect(await h.server.store.pathOf(bigId)).not.toBeNull()
    // The next open re-parses from the retained source into a new generation.
    const reopened = await h.request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: h.fileId }),
    })
    expect(reopened.status, await reopened.clone().text()).toBe(201)
    const { sessionId } = (await reopened.json()) as { sessionId: string }
    expect((await h.request(`/v1/sessions/${sessionId}/units/0`)).status).toBe(200)
    const [rebuilt] = await h.pool.query<ArtifactRow[]>(
      'SELECT * FROM parse_artifacts WHERE artifact_key = ?',
      [h.ready.key],
    )
    if (rebuilt.length) expect(Number(rebuilt[0].ready_generation)).toBeGreaterThan(1)
    else {
      const [tombstones] = await h.pool.query<RowDataPacket[]>(
        'SELECT generation FROM parse_artifact_archives WHERE artifact_key = ?',
        [h.ready.key],
      )
      expect(tombstones).toHaveLength(1)
    }
  })
})
