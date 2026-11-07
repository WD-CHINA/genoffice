import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, open, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import { LibraryStore } from '../src/library-store'
import { PendingSessionStore } from '../src/pending-session-store'
import { ArtifactSession } from '../src/artifact-session'
import { ArtifactStore, artifactKey } from '../src/artifact-store'
import { MysqlArtifactCatalog } from '../src/artifact-catalog'
import { ArtifactGenerations } from '../src/artifact-generations'
import { createBlankPptx } from '@genoffice/pptx-engine'

// Explicit opt-in socket must refer to an isolated test instance, never a production server.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.restoreAllMocks()
})

describe.skipIf(!socketPath)('saved library with real MySQL', () => {
  async function setup() {
    const database = `genoffice_test_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'library-mysql-'))
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
      await admin.query(`DROP DATABASE ${database}`)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const start = async (options: Partial<ParseServerOptions> = {}) => {
      const server = await createParseServer({
        dataDir,
        mysql: config,
        contentTtlMs: 1,
        token: 'secret',
        ...options,
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer, path: string, init?: RequestInit) =>
      fetch(server.url + path, {
        ...init,
        headers: { Authorization: 'Bearer secret', ...init?.headers },
      })
    const post = (server: ParseServer, path: string, body: unknown) =>
      request(server, path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    return { start, request, post, dataDir }
  }

  it.each(['pptx', 'docx'] as const)('serves catalog-backed %s HTTP sessions and restores without reparsing', async (format) => {
    const harness = await setup()
    const options = { artifactBackend: 'catalog' as const, contentTtlMs: 24 * 60 * 60_000 }
    const first = await harness.start(options)
    const body = format === 'pptx' ? Buffer.from(await createBlankPptx())
      : await readFile(new URL('./fixtures/docx/behavior.docx', import.meta.url))
    const uploaded = await harness.request(first, '/v1/files', { method: 'POST', body })
    expect(uploaded.status).toBe(201)
    const { fileId } = await uploaded.json() as { fileId: string }
    const parse = vi.spyOn(ArtifactSession, 'build')
    const response = await harness.post(first, '/v2/sessions', { fileId })
    expect(response.status).toBe(202)
    const { sessionId } = await response.json() as { sessionId: string }
    await expect.poll(async () => (await (await harness.request(first, `/v2/sessions/${sessionId}`)).json() as { state: string }).state,
      { timeout: 10_000 }).toBe('ready')
    const rendered = await harness.request(first, `/v1/sessions/${sessionId}/units/0`)
    expect(rendered.status).toBe(200)
    const originalUnit = await rendered.json()
    let originalStyles: unknown
    if (format === 'docx') {
      const styles = await harness.request(first, `/v1/sessions/${sessionId}/styles`)
      expect(styles.status).toBe(200)
      originalStyles = await styles.json()
    }
    expect(parse).toHaveBeenCalledTimes(1)
    const cached = await harness.post(first, '/v2/sessions', { fileId })
    expect(cached.status).toBe(201)
    await cached.json()
    await first.close()
    const second = await harness.start(options)
    const restored = await harness.request(second, `/v1/sessions/${sessionId}/units/0`)
    expect(restored.status).toBe(200)
    const restoredUnit = await restored.json()
    if (format === 'docx') {
      expect(restoredUnit).toEqual(originalUnit)
      const styles = await harness.request(second, `/v1/sessions/${sessionId}/styles`)
      expect(styles.status).toBe(200)
      expect(await styles.json()).toEqual(originalStyles)
    }
    expect(parse).toHaveBeenCalledTimes(1)
    const [rows] = await second.db!.pool.query<mysql.RowDataPacket[]>('SELECT ready_generation FROM parse_artifacts WHERE file_id = ?', [fileId])
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].ready_generation)).toBe(1)
    await second.close()
  }, 15_000)

  it.each(['manifest', 'document'] as const)('repairs a corrupt catalog %s on historical HTTP view restoration', async (record) => {
    const harness = await setup()
    const options = { artifactBackend: 'catalog' as const, contentTtlMs: 24 * 60 * 60_000 }
    const first = await harness.start(options)
    const uploaded = await harness.request(first, '/v1/files', { method: 'POST', body: Buffer.from(await createBlankPptx()) })
    const { fileId } = await uploaded.json() as { fileId: string }
    const parse = vi.spyOn(ArtifactSession, 'build')
    const opened = await harness.post(first, '/v1/sessions', { fileId })
    expect(opened.status).toBe(201)
    const { sessionId } = await opened.json() as { sessionId: string }
    const [rows] = await first.db!.pool.query<mysql.RowDataPacket[]>('SELECT storage_path FROM parse_artifacts WHERE file_id = ?', [fileId])
    const oldPath = join(harness.dataDir, rows[0].storage_path)
    await first.close()
    if (record === 'manifest') await writeFile(join(oldPath, 'manifest.json'), '{}')
    else {
      const manifest = JSON.parse(await readFile(join(oldPath, 'manifest.json'), 'utf8')) as {
        records: Array<{ id: string; offset: number }>
      }
      const document = manifest.records.find((item) => item.id === 'document')!
      const file = await open(join(oldPath, 'units.bin'), 'r+')
      try { await file.write(Buffer.from([0]), 0, 1, document.offset); await file.sync() }
      finally { await file.close() }
    }
    const second = await harness.start(options)
    const rendered = await harness.request(second, `/v1/sessions/${sessionId}/units/0`)
    expect(rendered.status).toBe(200)
    await rendered.arrayBuffer()
    expect(parse).toHaveBeenCalledTimes(2)
    const [current] = await second.db!.pool.query<mysql.RowDataPacket[]>('SELECT ready_generation FROM parse_artifacts WHERE file_id = ?', [fileId])
    expect(Number(current[0].ready_generation)).toBe(2)
    expect((await stat(oldPath)).isDirectory()).toBe(true)
    await second.close()
  }, 15_000)

  it('persists saved history across restart, enforces file references and permits GC after removal', async () => {
    const harness = await setup()
    const first = await harness.start()
    const uploaded = await harness.request(first, '/v1/files', {
      method: 'POST',
      body: Buffer.from('%PDF-1.7\n%%EOF\n'),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const saved = await harness.post(first, '/v2/library', { fileId, displayName: '历史资料' })
    expect(saved.status).toBe(201)
    const entry = (await saved.json()) as { id: string }
    await first.db!.pool.query('UPDATE parse_files SET created_at = ? WHERE file_id = ?', [
      '2000-01-01T00:00:00.000Z',
      fileId,
    ])
    await first.gc()
    expect(await first.store.pathOf(fileId)).not.toBeNull()
    await expect(first.store.remove(fileId)).rejects.toMatchObject({
      code: 'ER_ROW_IS_REFERENCED_2',
    })
    expect(await first.store.pathOf(fileId)).not.toBeNull()
    await first.close()
    const second = await harness.start()
    await second.gc()
    expect(await (await harness.request(second, '/v2/library')).json()).toMatchObject({
      items: [{ id: entry.id, fileId, displayName: '历史资料' }],
    })
    expect(
      (await harness.request(second, `/v1/files/${fileId}`, { method: 'DELETE' })).status,
    ).toBe(409)
    expect(
      (await harness.request(second, `/v2/library/${entry.id}`, { method: 'DELETE' })).status,
    ).toBe(204)
    await second.gc()
    expect(await second.store.pathOf(fileId)).toBeNull()
  })

  it('deduplicates concurrent saves through the database unique key', async () => {
    const harness = await setup()
    const server = await harness.start()
    const uploaded = await harness.request(server, '/v1/files', {
      method: 'POST',
      body: Buffer.from('%PDF-1.7\n%%EOF\n'),
    })
    const { fileId } = (await uploaded.json()) as { fileId: string }
    // Two independent store adapters exercise the SQL uniqueness path, not an in-memory mutex.
    const left = new LibraryStore(harness.dataDir, server.db)
    const right = new LibraryStore(harness.dataDir, server.db)
    const entries = await Promise.all([left.save(fileId, 'First'), right.save(fileId, 'Second')])
    expect(entries[0].id).toBe(entries[1].id)
    expect(await left.values()).toHaveLength(1)
    for (const index of [1, 2]) {
      const uploaded = await harness.request(server, '/v1/files', {
        method: 'POST',
        body: Buffer.from(`%PDF-1.7\n${index}\n%%EOF\n`),
      })
      const { fileId: nextFile } = (await uploaded.json()) as { fileId: string }
      expect(
        (
          await harness.post(server, '/v2/library', {
            fileId: nextFile,
            displayName: `PDF ${index}`,
          })
        ).status,
      ).toBe(201)
    }
    const page = (await (await harness.request(server, '/v2/library?limit=1')).json()) as {
      items: Array<{ id: string }>
      next: string
    }
    expect(page.items).toHaveLength(1)
    await harness.request(server, `/v2/library/${page.items[0].id}`, { method: 'DELETE' })
    const rest = (await (
      await harness.request(server, `/v2/library?limit=2&cursor=${page.next}`)
    ).json()) as { items: Array<{ id: string }> }
    expect(rest.items).toHaveLength(2)
    expect(rest.items.map((entry) => entry.id)).not.toContain(page.items[0].id)
  })
  it('recovers a durable async waiter from MySQL and promotes it without losing its session ID', async () => {
    const harness = await setup()
    const options = { parserFingerprint: 'mysql-async-test', parserVersion: '0.1.0' }
    const first = await harness.start(options)
    const uploaded = await harness.request(first, '/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    await harness.post(first, '/v2/library', { fileId, displayName: 'Async document' })
    // Seed the durable boundary left by an interrupted server, then restart before executing it.
    const journal = new PendingSessionStore(harness.dataDir, first.db)
    await journal.init(900_000)
    const identity = ArtifactSession.identity({ fileId, format: 'pptx', ...options })
    const now = Date.now()
    const pending = await journal.create({
      id: randomUUID(),
      artifactKey: artifactKey(identity),
      fileId,
      format: 'pptx',
      width: 960,
      ...options,
      createdAt: now,
      lastUsed: now,
    })
    await first.close()
    const second = await harness.start(options)
    let state: any
    const deadline = Date.now() + 10_000
    do {
      state = await (await harness.request(second, `/v2/sessions/${pending.id}`)).json()
      if (state.state === 'ready') break
      expect(state.state, JSON.stringify(state)).not.toBe('failed')
      await new Promise((resolve) => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    expect(state).toMatchObject({
      sessionId: pending.id,
      state: 'ready',
      model: { format: 'pptx' },
    })
    expect(
      (await harness.request(second, `/v2/sessions/${pending.id}/layout/slides/0`)).status,
    ).toBe(200)
    await second.close()
    const third = await harness.start(options)
    expect(
      (await harness.request(third, `/v2/sessions/${pending.id}/layout/slides/0`)).status,
    ).toBe(200)
    const health = (await (await harness.request(third, '/v1/health')).json()) as {
      artifacts: { buildsStarted: number }
    }
    expect(health.artifacts.buildsStarted).toBe(0)
  })
  it('retains catalog-referenced source files and legacy payloads across GC, DELETE and restart', async () => {
    const harness = await setup()
    const options = { contentTtlMs: 24 * 60 * 60_000 }
    const first = await harness.start(options)
    const uploaded = await harness.request(first, '/v1/files', {
      method: 'POST', body: Buffer.from(await createBlankPptx()),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = await uploaded.json() as { fileId: string }
    const opened = await harness.post(first, '/v1/sessions', { fileId })
    expect(opened.status).toBe(201)
    const { sessionId } = await opened.json() as { sessionId: string }
    await harness.request(first, `/v1/sessions/${sessionId}`, { method: 'DELETE' })
    const legacy = new ArtifactStore(harness.dataDir)
    const cached = (await legacy.list())[0]
    expect(cached).toBeDefined()
    const model = await cached.read('unit:0')
    const catalog = new MysqlArtifactCatalog(first.db!)
    const claim = await catalog.claim({ fileId, format: 'pptx', parserFingerprint: 'source-retention', schemaVersion: 2, options: {} }, 'builder')
    if (claim.kind !== 'acquired') throw new Error('expected build lease')
    await first.db!.pool.execute('UPDATE parse_files SET created_at = ? WHERE file_id = ?',
      ['2000-01-01T00:00:00.000Z', fileId])
    await first.gc()
    expect(await first.store.pathOf(fileId)).not.toBeNull()
    expect(await cached.read('unit:0')).toEqual(model)
    expect((await harness.request(first, `/v1/files/${fileId}`, { method: 'DELETE' })).status).toBe(409)
    expect(await catalog.fail(claim.lease, 'parse_failed')).toBe(true)
    await first.close()
    const second = await harness.start(options)
    await second.gc()
    const content = await harness.request(second, `/v1/files/${fileId}/content`)
    expect(content.status).toBe(200)
    await content.arrayBuffer()
    const denied = await harness.request(second, `/v1/files/${fileId}`, { method: 'DELETE' })
    expect(denied.status).toBe(409)
    expect(await denied.json()).toMatchObject({ code: 'file_in_use' })
    expect(await new MysqlArtifactCatalog(second.db!).hasFileReference(fileId)).toBe(true)
    expect(await (await legacy.find(cached.manifest.key))!.read('unit:0')).toEqual(model)
    // Removing this unretired test catalog row removes its source reference; normal expiry resumes.
    await second.db!.pool.execute('DELETE FROM parse_artifacts WHERE artifact_key = ?', [claim.lease.key])
    await second.gc()
    expect(await second.store.pathOf(fileId)).toBeNull()
    expect(await legacy.find(cached.manifest.key)).toBeNull()
  }, 15_000)

  it('keeps the database pool alive until already-started GC finishes during shutdown', async () => {
    const harness = await setup()
    const server = await harness.start()
    let release!: () => void
    let arrived!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { arrived = resolve })
    const list = vi.spyOn(server.store, 'list').mockImplementationOnce(async () => {
      arrived()
      await gate
      expect(await server.db!.ping()).toBe(true)
      return []
    })
    const end = vi.spyOn(server.db!.pool, 'end')
    const gc = server.gc()
    await started
    const closing = server.close()
    try {
      await delay(20)
      expect(end).not.toHaveBeenCalled()
      await server.gc()
      expect(list).toHaveBeenCalledTimes(1)
    } finally { release(); await Promise.all([gc, closing]) }
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('keeps MySQL available until a removed view finishes asynchronous disposal', async () => {
    const harness = await setup()
    const server = await harness.start()
    const uploaded = await harness.request(server, '/v1/files', { method: 'POST', body: Buffer.from(await createBlankPptx()) })
    expect(uploaded.status).toBe(201)
    const { fileId } = await uploaded.json() as { fileId: string }
    const opened = await harness.post(server, '/v1/sessions', { fileId })
    expect(opened.status).toBe(201)
    const { sessionId } = await opened.json() as { sessionId: string }
    let release!: () => void
    let arrived!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { arrived = resolve })
    const original = ArtifactSession.prototype.dispose
    const dispose = vi.spyOn(ArtifactSession.prototype, 'dispose').mockImplementationOnce(async function (this: ArtifactSession) {
      arrived()
      await gate
      expect(await server.db!.ping()).toBe(true)
      await original.call(this)
    })
    const removed = await harness.request(server, `/v1/sessions/${sessionId}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    await removed.arrayBuffer()
    await started
    const end = vi.spyOn(server.db!.pool, 'end')
    const closing = server.close()
    try {
      await delay(20)
      expect(end).not.toHaveBeenCalled()
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally { release(); await closing }
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('runs generation collection from the live MySQL server while preserving active readers and source files', async () => {
    const harness = await setup()
    const server = await harness.start({ contentTtlMs: 24 * 60 * 60_000, gcIntervalMs: 30 })
    const uploaded = await harness.request(server, '/v1/files', {
      method: 'POST', body: Buffer.from('%PDF-1.7\nlive-generation-gc\n%%EOF\n'),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = await uploaded.json() as { fileId: string }
    const catalog = new MysqlArtifactCatalog(server.db!)
    const identity = { fileId, format: 'pdf' as const, parserFingerprint: 'live-collection', schemaVersion: 2, options: {} }
    const disk = new ArtifactGenerations(harness.dataDir)
    const publish = async (generation: number) => {
      const ready = await disk.publish(identity, generation, async (writer) => { await writer.append('unit:0', { generation }) })
      const old = new Date(Date.now() - 2 * 60 * 60_000)
      await utimes(join(harness.dataDir, ready.storagePath), old, old)
      return ready
    }
    const first = await catalog.claim(identity, 'first')
    if (first.kind !== 'acquired') throw new Error('expected build lease')
    await server.db!.pool.execute('UPDATE parse_files SET created_at = ? WHERE file_id = ?', ['2000-01-01T00:00:00.000Z', fileId])
    const old = await publish(first.lease.generation)
    await catalog.complete(first.lease, old)
    const reader = (await catalog.pin(old.key, 'old-reader'))!
    const next = await catalog.claim(identity, 'next', true)
    if (next.kind !== 'acquired') throw new Error('expected replacement lease')
    const current = await publish(next.lease.generation)
    await catalog.complete(next.lease, current)
    const health = async () => await (await harness.request(server, '/v1/health')).json() as {
      maintenance: { generationCollection: { lastResult?: { protected: number } } }
    }
    await expect.poll(async () => (await health()).maintenance.generationCollection.lastResult?.protected,
      { timeout: 10_000 }).toBe(2)
    expect((await stat(join(harness.dataDir, old.storagePath))).isDirectory()).toBe(true)
    await catalog.releaseRead(reader.lease)
    await server.gc() // Also nudges the already-running collector without overlapping it.
    await expect.poll(async () => {
      try { await stat(join(harness.dataDir, old.storagePath)); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
    }, { timeout: 10_000 }).toBe(false)
    // Exercise the actual service timer, not just the standalone sweeper.
    const building = await catalog.claim(identity, 'staging-builder', true)
    if (building.kind !== 'acquired') throw new Error('expected staging lease')
    const stageName = `gen-${current.key}-g-${building.lease.generation}-${randomUUID()}`
    const stageRoot = join(harness.dataDir, 'staging')
    const stagePath = join(stageRoot, stageName)
    await mkdir(stagePath, { recursive: true })
    await writeFile(join(stagePath, 'units.bin'), 'unfinished')
    const ancient = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(stagePath, ancient, ancient)
    await expect.poll(async () => (await health()).maintenance.generationCollection.lastResult?.protected,
      { timeout: 10_000 }).toBe(2)
    expect(await readdir(stageRoot)).toContain(stageName)
    await server.db!.pool.execute('UPDATE parse_jobs SET lease_until = 0 WHERE artifact_key = ?', [current.key])
    await expect.poll(async () => (await readdir(stageRoot)).includes(stageName), { timeout: 10_000 }).toBe(false)
    expect(await catalog.renew(building.lease)).toBe(false)
    expect(await catalog.complete(building.lease, current)).toBe(false)
    expect(await (await disk.open(current)).read('unit:0')).toEqual({ generation: 2 })
    expect(await server.store.pathOf(fileId)).not.toBeNull()
    expect((await harness.request(server, `/v1/files/${fileId}`, { method: 'DELETE' })).status).toBe(409)
  }, 15_000)

})
