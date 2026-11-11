import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

describe.skipIf(!socketPath)('layout preferences persistence over real MySQL', () => {
  it('stores layout_prefs and restores them after a restart', async () => {
    const database = `genoffice_layout_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'layout-mysql-'))
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath }
    const start = async (): Promise<ParseServer> => {
      const server = await createParseServer({
        dataDir, mysql: config, parserVersion: '0.1.0', parserFingerprint: 'layout-mysql-test',
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const prefs = { zoom: 0.75, page: 4, anchor: { unitId: '7', blockIndex: 2, offsetPx: -8 } }
    const first = await start()
    const uploaded = await request(first)('/v1/files', {
      method: 'POST', body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = await uploaded.json() as { fileId: string }
    const opened = await request(first)('/v2/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, layoutPrefs: prefs }),
    })
    expect([201, 202]).toContain(opened.status)
    const { sessionId } = await opened.json() as { sessionId: string }
    const deadline = Date.now() + 20_000
    for (;;) {
      const status = await request(first)(`/v2/sessions/${sessionId}`)
      const body = await status.json() as { state: string }
      if (body.state === 'ready') break
      if (body.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const row = (await first.db!.pool.query<RowDataPacket[]>(
      'SELECT layout_prefs FROM parse_sessions WHERE id = ?', [sessionId],
    ))[0][0]
    const stored = typeof row.layout_prefs === 'string' ? JSON.parse(row.layout_prefs) : row.layout_prefs
    expect(stored).toEqual(prefs)

    await first.close()
    const second = await start()
    const restored = await (await request(second)(`/v2/sessions/${sessionId}`)).json() as {
      state: string
      layoutPrefs?: unknown
    }
    expect(restored.state).toBe('ready')
    expect(restored.layoutPrefs).toEqual(prefs)
  }, 60_000)
})
