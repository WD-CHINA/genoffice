import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

describe.skipIf(!socketPath)('shared Idempotency-Key ledger over real MySQL', () => {
  it('replays the same session across instances and restarts, merging concurrent retries', async () => {
    const database = `genoffice_shared_idem_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'shared-idem-'))
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const config = {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database,
      socketPath,
    }
    const start = async (): Promise<ParseServer> => {
      const server = await createParseServer({
        dataDir,
        mysql: config,
        artifactBackend: 'catalog',
        parserVersion: '0.1.0',
        parserFingerprint: 'shared-idem-test',
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const create = (server: ParseServer, fileId: string, key: string) =>
      request(server)('/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ fileId }),
      })
    const a = await start()
    const b = await start()
    const uploaded = await request(a)('/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = (await uploaded.json()) as { fileId: string }

    // Concurrent retries through two instances merge into one session.
    const key = `shared-${randomUUID()}`
    const [first, second] = await Promise.all([create(a, fileId, key), create(b, fileId, key)])
    expect([201, 202]).toContain(first.status)
    expect([201, 202]).toContain(second.status)
    const firstBody = (await first.json()) as { sessionId: string }
    const secondBody = (await second.json()) as { sessionId: string }
    expect(secondBody.sessionId).toBe(firstBody.sessionId)

    // A later retry from another instance replays immediately.
    const third = await create(b, fileId, key)
    expect([201, 202]).toContain(third.status)
    expect(((await third.json()) as { sessionId: string }).sessionId).toBe(firstBody.sessionId)

    // Restart: the ledger is durable, so the same key still maps to the session.
    await b.close()
    const c = await start()
    const afterRestart = await create(c, fileId, key)
    expect([201, 202]).toContain(afterRestart.status)
    expect(((await afterRestart.json()) as { sessionId: string }).sessionId).toBe(
      firstBody.sessionId,
    )
    const [row] = await c.db!.pool.query<import('mysql2/promise').RowDataPacket[]>(
      'SELECT body FROM parse_idempotency WHERE scope = ? AND idempotency_key = ?',
      ['v2:sessions', key],
    )
    expect(row).toHaveLength(1)
    expect(row[0].body).not.toBeNull()
  }, 90_000)
})
