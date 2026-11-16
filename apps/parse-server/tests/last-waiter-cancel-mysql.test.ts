import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactWriter, type JsonValue } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await drainCleanups(cleanups)
})
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function pauseBeforeDone() {
  const entered = gate()
  const blocked = gate()
  const original = ArtifactWriter.prototype.append
  let paused = false
  vi.spyOn(ArtifactWriter.prototype, 'append').mockImplementation(async function (
    this: ArtifactWriter,
    id: string,
    value: JsonValue | Uint8Array,
  ) {
    if (id === 'external-media' && !paused) {
      paused = true
      entered.resolve()
      await blocked.promise
    }
    return original.call(this, id, value)
  })
  return { entered, blocked }
}
async function buildsStarted(server: ParseServer): Promise<number> {
  const health = (await (await fetch(server.url + '/v1/health')).json()) as {
    artifacts: { buildsStarted: number }
  }
  return health.artifacts.buildsStarted
}

describe.skipIf(!socketPath)('last-waiter cancellation over real MySQL', () => {
  async function setup() {
    const database = `genoffice_lastwaiter_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'last-waiter-'))
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
        parserFingerprint: 'last-waiter-test',
        maxParseJobs: 1,
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const open = async (server: ParseServer): Promise<string> => {
      const uploaded = await request(server)('/v1/files', {
        method: 'POST',
        body: Buffer.from(await createBlankPptx()),
      })
      const { fileId } = (await uploaded.json()) as { fileId: string }
      const opened = await request(server)('/v1/sessions', {
        method: 'POST',
        headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
        body: JSON.stringify({ fileId }),
      })
      expect(opened.status).toBe(202)
      return ((await opened.json()) as { sessionId: string }).sessionId
    }
    const pendingRows = async (server: ParseServer, id: string): Promise<number> => {
      const [rows] = await server.db!.pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM parse_pending_sessions WHERE id = ?',
        [id],
      )
      return Number(rows[0].n)
    }
    return { admin, dataDir, start, request, open, pendingRows }
  }

  it('discards a pending build when its only waiting view cancels', async () => {
    const h = await setup()
    const server = await h.start()
    const pause = pauseBeforeDone()
    try {
      const sessionId = await h.open(server)
      await pause.entered.promise
      expect(await h.pendingRows(server, sessionId)).toBe(1)
      const cancelled = await h.request(server)(`/v1/sessions/${sessionId}`, { method: 'DELETE' })
      expect(cancelled.status).toBe(204)
      expect(await h.pendingRows(server, sessionId)).toBe(0)
      pause.blocked.resolve()
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        if ((await buildsStarted(server)) >= 1) break
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      const [ready] = await server.db!.pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS n FROM parse_sessions WHERE id = ?',
        [sessionId],
      )
      expect(Number(ready[0].n)).toBe(0)
      expect((await h.request(server)(`/v1/sessions/${sessionId}`)).status).toBe(404)
    } finally {
      pause.blocked.resolve()
    }
  }, 60_000)

  it('keeps the build alive while another instance still reads the waiter', async () => {
    const h = await setup()
    const a = await h.start()
    const b = await h.start()
    const pause = pauseBeforeDone()
    try {
      const sessionId = await h.open(a)
      await pause.entered.promise
      // B attaches read-only and registers its durable reader.
      expect((await h.request(b)(`/v1/sessions/${sessionId}`)).status).toBe(200)
      // A closes its view: B is still waiting, so the shared row must stay.
      expect((await h.request(a)(`/v1/sessions/${sessionId}`, { method: 'DELETE' })).status).toBe(
        204,
      )
      expect(await h.pendingRows(a, sessionId)).toBe(1)
      expect((await h.request(b)(`/v1/sessions/${sessionId}`)).status).toBe(200)
      pause.blocked.resolve()
      const deadline = Date.now() + 30_000
      let state = ''
      while (Date.now() < deadline) {
        const response = await h.request(b)(`/v1/sessions/${sessionId}`)
        if (response.status === 200) {
          state = ((await response.json()) as { state: string }).state
          if (state === 'ready') break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(state).toBe('ready')
      expect(await buildsStarted(a)).toBe(1)
      expect(await buildsStarted(b)).toBe(0)
      expect(
        (await h.request(b)(`/v1/sessions/${sessionId}/units/0?representation=model`)).status,
      ).toBe(200)
    } finally {
      pause.blocked.resolve()
    }
  }, 60_000)
})
