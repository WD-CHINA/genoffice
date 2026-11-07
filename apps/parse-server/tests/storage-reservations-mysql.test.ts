import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { FileLifecycle } from '../src/file-lifecycle'
import { MysqlDatabase } from '../src/mysql'
import { createParseServer, type ParseServer } from '../src/server'
import { StorageBudget } from '../src/storage-budget'
import { SqlStorageReservations } from '../src/storage-reservations'

// Explicit opt-in socket must refer to an isolated test instance, never a production server.
const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

describe.skipIf(!socketPath)('cross-process storage admission with real MySQL', () => {
  async function setup() {
    const database = `genoffice_storage_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const config = {
      host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath,
    }
    const dataDir = await mkdtemp(join(tmpdir(), 'storage-admission-'))
    const databases: MysqlDatabase[] = []
    const ledgers: SqlStorageReservations[] = []
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      for (const ledger of ledgers) await ledger.close().catch(() => undefined)
      for (const database of databases) await database.close().catch(() => undefined)
      await admin.query(`DROP DATABASE ${database}`)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const instance = async () => {
      const db = new MysqlDatabase(config)
      databases.push(db)
      const ledger = new SqlStorageReservations(db, {
        blockBytes: 8, leaseMs: 10_000, lockTimeoutMs: 3000,
      })
      ledgers.push(ledger)
      await ledger.init()
      return { db, ledger }
    }
    const budget = (ledger: SqlStorageReservations, limit = 100) => {
      const lock = new FileLifecycle()
      return new StorageBudget(limit, async () => 0,
        (work) => lock.withFile('storage', work), undefined, undefined,
        { highPercent: 100, lowPercent: 100 }, ledger)
    }
    return { config, dataDir, instance, budget, servers }
  }

  it('fences in-flight bytes across two independent instances', async () => {
    const h = await setup()
    const a = await h.instance()
    const b = await h.instance()
    const first = h.budget(a.ledger).reservation()
    const second = h.budget(b.ledger).reservation()
    await first.reserve(60)
    // 60 rounds up to a 64-byte block, visible to the other process.
    expect(await b.ledger.reservedBytes()).toBe(64)
    await expect(second.reserve(60)).rejects.toMatchObject({ code: 'storage_full' })
    expect(await a.ledger.reservedBytes()).toBe(64)
    await first.release()
    expect(await b.ledger.reservedBytes()).toBe(0)
    await second.reserve(32)
    expect(await a.ledger.reservedBytes()).toBe(32)
    await second.release()
    expect(await b.ledger.reservedBytes()).toBe(0)
  })

  it('serializes concurrent admissions so only one writer wins the quota', async () => {
    const h = await setup()
    const a = await h.instance()
    const b = await h.instance()
    const first = h.budget(a.ledger).reservation()
    const second = h.budget(b.ledger).reservation()
    const results = await Promise.allSettled([first.reserve(60), second.reserve(60)])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(await a.ledger.reservedBytes()).toBe(64)
    await Promise.all([first.release(), second.release()])
    expect(await b.ledger.reservedBytes()).toBe(0)
  })

  it('reclaims expired rows left by a crashed writer', async () => {
    const h = await setup()
    const a = await h.instance()
    const b = await h.instance()
    await a.ledger.set('crashed-writer', 500)
    expect(await b.ledger.reservedBytes()).toBe(500)
    await a.db.pool.query(
      'UPDATE parse_storage_reservations SET expires_at_ms = ? WHERE id = ?',
      [Date.now() - 1, 'crashed-writer'],
    )
    expect(await b.ledger.reservedBytes()).toBe(0)
    expect(await b.ledger.reconcile()).toBe(1)
    expect(await b.ledger.renew('crashed-writer')).toBe(false)
  })

  it('graceful shutdown releases only this instance rows', async () => {
    const h = await setup()
    const a = await h.instance()
    const b = await h.instance()
    await a.ledger.set('a-row', 10)
    await b.ledger.set('b-row', 20)
    expect(await b.ledger.reservedBytes()).toBe(30)
    await a.ledger.close()
    expect(await b.ledger.reservedBytes()).toBe(20)
    expect(await a.ledger.renew('a-row')).toBe(false)
    expect(await b.ledger.renew('b-row')).toBe(true)
  })

  it('catalog backend defaults to shared admission and honors an explicit opt-out', async () => {
    const h = await setup()
    const start = async (storageAdmission?: 'instance' | 'shared') => {
      const server = await createParseServer({
        dataDir: h.dataDir, mysql: h.config, artifactBackend: 'catalog',
        maxStoreBytes: 1024 ** 3, token: 'secret',
        ...(storageAdmission ? { storageAdmission } : {}),
      })
      h.servers.push(server)
      return server
    }
    const shared = await start()
    const health = await (await fetch(shared.url + '/v1/health')).json() as {
      storageBudget: { coordination: string; sharedReservedBytes: number }
    }
    expect(health.storageBudget.coordination).toBe('shared')
    expect(health.storageBudget.sharedReservedBytes).toBe(0)
    const local = await start('instance')
    const localHealth = await (await fetch(local.url + '/v1/health')).json() as {
      storageBudget: { coordination: string; sharedReservedBytes: number }
    }
    expect(localHealth.storageBudget.coordination).toBe('instance')
    expect(localHealth.storageBudget.sharedReservedBytes).toBe(0)
  })
})
