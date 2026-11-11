import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactWriter, type JsonValue } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()!()
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
function pauseBeforeDone() {
  const entered = gate()
  const blocked = gate()
  const original = ArtifactWriter.prototype.append
  let paused = false
  vi.spyOn(ArtifactWriter.prototype, 'append').mockImplementation(
    async function (this: ArtifactWriter, id: string, value: JsonValue | Uint8Array) {
      if (id === 'external-media' && !paused) {
        paused = true
        entered.resolve()
        await blocked.promise
      }
      return original.call(this, id, value)
    },
  )
  return { entered, blocked }
}
async function buildsStarted(server: ParseServer): Promise<number> {
  const health = await (await fetch(server.url + '/v1/health')).json() as {
    artifacts: { buildsStarted: number }
  }
  return health.artifacts.buildsStarted
}

describe.skipIf(!socketPath)('crash takeover of a remote pending waiter over real MySQL', () => {
  it('resumes a waiter whose builder shut down before publishing', async () => {
    const database = `genoffice_takeover_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'takeover-'))
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath }
    // Same deployment precondition as ready attach: one dataDir + one catalog.
    const start = async (): Promise<ParseServer> => {
      const server = await createParseServer({
        dataDir, mysql: config, artifactBackend: 'catalog',
        parserVersion: '0.1.0', parserFingerprint: 'takeover-test', maxParseJobs: 1,
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const pause = pauseBeforeDone()
    try {
    const a = await start()
    const b = await start()
    const uploaded = await request(a)('/v1/files', {
      method: 'POST', body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = await uploaded.json() as { fileId: string }
    const opened = await request(a)('/v2/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(opened.status).toBe(202)
    const { sessionId } = await opened.json() as { sessionId: string }
    await Promise.race([
      pause.entered.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('build never paused')), 15_000)),
    ])
    // B sees the shared waiter while A is still alive and does not take over.
    // The remote journal does not carry A's in-process building flag, so a
    // queued/building view is both valid; the decisive check is buildsStarted.
    const during = await request(b)(`/v2/sessions/${sessionId}`)
    expect(during.status).toBe(200)
    expect(['queued', 'building']).toContain(
      (await during.json() as { state: string }).state,
    )
    expect(await buildsStarted(b)).toBe(0)

    // Simulate A crashing: closing aborts its build before publication; the
    // durable waiter row stays for another instance to resume.
    const closing = a.close()
    pause.blocked.resolve()
    await closing
    const deadline = Date.now() + 30_000
    let state = ''
    while (Date.now() < deadline) {
      const response = await request(b)(`/v2/sessions/${sessionId}`)
      if (response.status === 200) {
        const body = await response.json() as { state: string }
        state = body.state
        if (state === 'ready') break
        if (state === 'failed') throw new Error('takeover build failed')
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(state).toBe('ready')
    expect(await buildsStarted(b)).toBe(1)
    expect((await request(b)(`/v2/sessions/${sessionId}/units/0`)).status).toBe(200)
    } finally {
      pause.blocked.resolve()
    }
  }, 90_000)
})
