import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { MysqlArtifactCatalog } from '../src/artifact-catalog'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactReadyEviction } from '../src/artifact-ready-eviction'
import { MysqlDatabase } from '../src/mysql'
import { SqlPressureLedger } from '../src/storage-pressure'
import { createParseServer, type ParseServer } from '../src/server'

// Explicit opt-in socket must refer to an isolated test instance, never a production server.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

/**
 * Distinct ready artifacts need distinct source bytes.
 * `createBlankPptx` embeds the JSZip DOS timestamp (2 s granularity), so two
 * calls inside one window are byte-identical and the content-addressed upload
 * collapses them into a single file. Regenerate until the bytes differ.
 */
async function distinctBlankDecks(count: number): Promise<Buffer[]> {
  const decks: Buffer[] = []
  for (let index = 0; index < count; index++) {
    for (let attempt = 0; ; attempt++) {
      const deck = Buffer.from(await createBlankPptx())
      if (!decks.some((other) => other.equals(deck))) {
        decks.push(deck)
        break
      }
      if (attempt >= 8) throw new Error('blank decks did not become distinct in time')
      await new Promise((resolve) => setTimeout(resolve, 1100))
    }
  }
  return decks
}

describe.skipIf(!socketPath)('shared pressure budget over real MySQL', () => {
  async function setup(options: { roundMs?: number; cooldownMs?: number } = {}) {
    const database = `genoffice_pressure_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '',
      database, socketPath }
    const dataDir = await mkdtemp(join(tmpdir(), 'pressure-mysql-'))
    const databases: MysqlDatabase[] = []
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await Promise.all(databases.map((db) => db.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const newDb = () => {
      const db = new MysqlDatabase(config)
      databases.push(db)
      return db
    }
    const instance = async (override: { roundMs?: number; cooldownMs?: number } = {}) => {
      const db = newDb()
      const ledger = new SqlPressureLedger(db, { ...options, ...override })
      await ledger.init()
      return { db, ledger }
    }
    return { config, dataDir, servers, newDb, instance }
  }

  it('merges targets, bounds concurrent reserves and refunds across two pools', async () => {
    const h = await setup()
    const a = await h.instance()
    const b = await h.instance()
    expect(await a.ledger.state()).toBeNull()
    const first = await a.ledger.register(100)
    const second = await b.ledger.register(250)
    expect(first).toMatchObject({ round: 1, targetBytes: 100, remainingBytes: 100 })
    expect(second).toMatchObject({ round: 1, targetBytes: 250, remainingBytes: 250 })
    expect((await a.ledger.state())!.targetBytes).toBe(250)
    const racing = await Promise.all([
      a.ledger.reserve(first.round, 200),
      b.ledger.reserve(second.round, 200),
    ])
    expect(racing.filter(Boolean)).toHaveLength(1)
    expect((await b.ledger.state())!.reclaimedBytes).toBe(200)
    expect(await a.ledger.reserve(first.round, 51)).toBe(false)
    expect(await b.ledger.reserve(second.round, 50)).toBe(true)
    expect(await b.ledger.state()).toMatchObject({ targetBytes: 250,
      reclaimedBytes: 250, remainingBytes: 0 })
    await a.ledger.refund(first.round, 50)
    expect(await b.ledger.state()).toMatchObject({ reclaimedBytes: 200,
      remainingBytes: 50 })
    expect(await a.ledger.reserve(first.round + 5, 10)).toBe(false)
    expect(await a.ledger.reserve(first.round, 10)).toBe(true)
    await expect(a.ledger.register(0)).rejects.toThrow(/invalid/)
    await expect(b.ledger.reserve(first.round, 0)).rejects.toThrow(/invalid/)
  })

  it('a satisfied round uses the short cooldown and old rounds cannot charge it', async () => {
    const h = await setup({ roundMs: 1000, cooldownMs: 1000 })
    const a = await h.instance()
    const round = (await a.ledger.register(100)).round
    expect(await a.ledger.reserve(round, 100)).toBe(true)
    const state = (await a.ledger.state())!
    expect(state.expiresAt).toBeLessThanOrEqual(Date.now() + 1050)
    await new Promise((resolve) => setTimeout(resolve, 1150))
    expect((await a.ledger.state())!.expired).toBe(true)
    expect(await a.ledger.reserve(round, 1)).toBe(false)
    const next = await a.ledger.register(50)
    expect(next).toMatchObject({ round: round + 1, targetBytes: 50,
      reclaimedBytes: 0, remainingBytes: 50 })
    expect(await a.ledger.reserve(round, 10)).toBe(false)
    expect(await a.ledger.reserve(next.round, 10)).toBe(true)
  })

  it('validates the ledger durations before any SQL runs', async () => {
    const h = await setup()
    const db = h.newDb()
    expect(() => new SqlPressureLedger(db, { roundMs: 10_000,
      cooldownMs: 60_000 })).toThrow(/cooldown/)
    expect(() => new SqlPressureLedger(db, { roundMs: 0 })).toThrow(/round/)
    expect(() => new SqlPressureLedger(db, { roundMs: 10_000,
      cooldownMs: 1000 })).not.toThrow()
  })

  it('two catalog instances reclaim only one shared target through real SQL rows', async () => {
    const h = await setup()
    const server = await createParseServer({
      dataDir: h.dataDir, mysql: h.config, artifactBackend: 'catalog', token: 'secret',
      parserFingerprint: 'shared-pressure-mysql-test', readyEvictionIdleMs: 0,
    })
    h.servers.push(server)
    const request = (path: string, init?: RequestInit) => fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
    const sessionIds: string[] = []
    for (const deck of await distinctBlankDecks(3)) {
      const uploaded = await request('/v1/files', {
        method: 'POST', body: deck,
      })
      expect(uploaded.status, await uploaded.clone().text()).toBe(201)
      const { fileId } = await uploaded.json() as { fileId: string }
      const opened = await request('/v1/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
      expect(opened.status, await opened.clone().text()).toBe(201)
      sessionIds.push((await opened.json() as { sessionId: string }).sessionId)
    }
    for (const sessionId of sessionIds)
      await request(`/v1/sessions/${sessionId}`, { method: 'DELETE' })
    const pool = server.db!.pool
    const deadline = Date.now() + 5000
    for (;;) {
      const [leases] = await pool.query<RowDataPacket[]>(
        'SELECT id FROM parse_artifact_read_leases')
      if (!leases.length) break
      if (Date.now() > deadline) throw new Error('read leases were not released')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const [rows] = await pool.query<RowDataPacket[]>(`
      SELECT bytes FROM parse_artifacts
      WHERE ready_generation IS NOT NULL ORDER BY last_access_at ASC LIMIT 1`)
    expect(rows).toHaveLength(1)
    const oneBytes = Number(rows[0].bytes)
    expect(oneBytes).toBeGreaterThan(0)
    // Budget for exactly one generation. Without the shared ledger each of the
    // two instances would withdraw one generation (two total).
    const target = oneBytes + 1
    const a = await h.instance()
    const b = await h.instance()
    const disk = new ArtifactGenerations(h.dataDir)
    const build = (db: MysqlDatabase, ledger: SqlPressureLedger) =>
      new ArtifactReadyEviction(new MysqlArtifactCatalog(db), disk, {
        idleMs: 0,
        sourceExists: async (fileId) => !!(await server.store.pathOf(fileId)),
        ledger,
      })
    const first = build(a.db, a.ledger)
    const second = build(b.db, b.ledger)
    first.request(target)
    second.request(target)
    const [r1, r2] = await Promise.all([first.run(), second.run()])
    expect(r1.withdrawn + r2.withdrawn).toBe(1)
    expect(r1.collected + r2.collected).toBe(1)
    expect(r1.bytesFreed + r2.bytesFreed).toBe(oneBytes)
    const shared = (await a.ledger.state())!
    expect(shared).toMatchObject({ targetBytes: target, reclaimedBytes: oneBytes })
    expect(shared.reclaimedBytes).toBeLessThanOrEqual(shared.targetBytes)
    const [after] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS ready FROM parse_artifacts WHERE ready_generation IS NOT NULL')
    expect(Number(after[0].ready)).toBe(2)
    // The server's own ledger reads the same row through /v1/health.
    const health = await (await request('/v1/health')).json() as {
      sharedPressure: { round: number; targetBytes: number; reclaimedBytes: number } | null
    }
    expect(health.sharedPressure).toMatchObject({ targetBytes: target,
      reclaimedBytes: oneBytes })
  })
})
