import { drainCleanups } from './helpers/cleanup'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { MysqlArtifactCatalog, type ReadyArtifact } from '../src/artifact-catalog'
import { ArtifactStore } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

// Explicit opt-in socket must refer to an isolated test instance, never a production server.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

interface ArtifactRow extends RowDataPacket {
  artifact_key: string
  state: string
  ready_generation: number | null
  storage_path: string
  manifest_sha256: string
  bytes: number
  unit_count: number
}

describe.skipIf(!socketPath)('legacy flat archive over real MySQL', () => {
  async function setup() {
    const database = `genoffice_flat_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'flat-mysql-'))
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
      parserFingerprint: 'flat-mysql-test',
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
    const [rows] = await server.db!.pool.query<ArtifactRow[]>(
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
    const catalog = new MysqlArtifactCatalog(server.db!)
    const archives = async () =>
      (
        await server.db!.pool.query<RowDataPacket[]>(
          'SELECT artifact_key, generation, manifest_sha256 FROM parse_artifact_flat_archives',
        )
      )[0]
    return { server, dataDir, request, sessionId, row, ready, catalog, archives }
  }

  it('authorizes only a settled ready pointer and records an irreversible archive', async () => {
    const h = await setup()
    expect(await h.archives()).toHaveLength(0)
    const ready = await h.catalog.authorizeFlatArchive(h.row.artifact_key)
    expect(ready).toMatchObject({
      key: h.row.artifact_key,
      generation: 1,
      storagePath: h.ready.storagePath,
      manifestSha256: h.row.manifest_sha256,
    })
    expect(await h.archives()).toEqual([
      { artifact_key: h.row.artifact_key, generation: 1, manifest_sha256: h.row.manifest_sha256 },
    ])

    // Idempotent: repeated authorization never creates a second archive row.
    expect(await h.catalog.authorizeFlatArchive(h.row.artifact_key)).toMatchObject({
      generation: 1,
    })
    expect(await h.archives()).toHaveLength(1)

    // A live builder could still be reading the flat files (legacy import).
    await h.server.db!.pool.execute(
      `UPDATE parse_jobs SET state = 'building', lease_until = ? WHERE artifact_key = ?`,
      [Date.now() + 60_000, h.row.artifact_key],
    )
    expect(await h.catalog.authorizeFlatArchive(h.row.artifact_key)).toBeNull()
    await h.server.db!.pool.execute(
      `UPDATE parse_jobs SET state = 'ready', lease_until = NULL WHERE artifact_key = ?`,
      [h.row.artifact_key],
    )
    expect(await h.catalog.authorizeFlatArchive(h.row.artifact_key)).toMatchObject({
      generation: 1,
    })

    // A retired generation cannot authorize removal of its last legacy copy.
    await h.server.db!.pool.execute(
      'INSERT INTO parse_artifact_retirements (artifact_key, generation, retired_at) VALUES (?, ?, ?)',
      [h.row.artifact_key, 1, Date.now()],
    )
    expect(await h.catalog.authorizeFlatArchive(h.row.artifact_key)).toBeNull()
    await h.server.db!.pool.execute(
      'DELETE FROM parse_artifact_retirements WHERE artifact_key = ?',
      [h.row.artifact_key],
    )

    // Conditional invalidation removes readiness, so no archive may be issued.
    expect(await h.catalog.invalidateReady(h.ready)).toBe(true)
    expect(await h.catalog.authorizeFlatArchive(h.row.artifact_key)).toBeNull()
  }, 20_000)

  it('cleans injected legacy flat files through GC, keeps the generation and reconciles quota bytes', async () => {
    const h = await setup()
    const key = h.row.artifact_key
    const directory = join(h.dataDir, 'artifacts', key.slice(0, 2), key)
    const legacyManifest = Buffer.from('pre-generation manifest')
    const legacyUnits = Buffer.from('pre-generation units')
    const flatBytes = legacyManifest.length + legacyUnits.length
    await writeFile(join(directory, 'manifest.json'), legacyManifest)
    await writeFile(join(directory, 'units.bin'), legacyUnits)
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(join(directory, 'manifest.json'), old, old)
    await utimes(join(directory, 'units.bin'), old, old)

    const store = new ArtifactStore(h.dataDir)
    const before = await store.totalBytes()
    expect((await store.legacyFlatEntries()).bytes).toBe(flatBytes)

    await h.server.gc()
    const health = async () =>
      (await (await h.request('/v1/health')).json()) as {
        errors: number
        artifacts: {
          legacyFlatCollected: number
          legacyFlatCollectedBytes: number
          legacyFlatPendingBytes: number
        }
      }
    let latest = await health()
    const deadline = Date.now() + 10_000
    while (latest.artifacts.legacyFlatCollected < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      latest = await health()
    }
    expect(latest.artifacts.legacyFlatCollected).toBe(1)
    expect(latest.artifacts.legacyFlatCollectedBytes).toBe(flatBytes)
    expect(latest.artifacts.legacyFlatPendingBytes).toBe(0)
    expect(latest.errors).toBe(0)

    const children = await readdir(directory)
    expect(children).not.toContain('manifest.json')
    expect(children).not.toContain('units.bin')
    expect(children).toContain('g-1')
    expect(
      (await stat(join(h.dataDir, h.ready.storagePath, 'manifest.json'))).size,
    ).toBeGreaterThan(0)
    expect(await store.totalBytes()).toBe(before - flatBytes)
    expect((await store.legacyFlatEntries()).bytes).toBe(0)
    expect(await h.archives()).toEqual([
      { artifact_key: key, generation: 1, manifest_sha256: h.row.manifest_sha256 },
    ])

    const unit = await h.request(`/v1/sessions/${h.sessionId}/units/0`)
    expect(unit.status, await unit.clone().text()).toBe(200)

    // A repeat GC must not double-count or touch the surviving generation.
    await h.server.gc()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await health()).artifacts.legacyFlatCollected).toBe(1)
    expect(await readdir(directory)).toContain('g-1')
  }, 30_000)
})
