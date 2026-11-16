import { drainCleanups } from './helpers/cleanup'
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
  await drainCleanups(cleanups)
})

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Pause the build right before the final frame: the session stays pending. */
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

interface Env {
  database: string
  builder: ParseServer
  reader: ParseServer
  requestOf: (server: ParseServer) => (path: string, init?: RequestInit) => Promise<Response>
  upload: (server: ParseServer, bytes: Uint8Array) => Promise<string>
  open: (server: ParseServer, fileId: string) => Promise<{ status: number; sessionId: string }>
}

async function createEnvironment(): Promise<Env> {
  const database = `genoffice_journal_${randomUUID().replaceAll('-', '')}`
  const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
  await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
  const dirs: string[] = []
  const servers: ParseServer[] = []
  cleanups.push(async () => {
    await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
    await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
    await admin.end()
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })
  const requestOf = (server: ParseServer) => (path: string, init?: RequestInit) =>
    fetch(server.url + path, init)
  const upload = async (server: ParseServer, bytes: Uint8Array): Promise<string> => {
    const response = await requestOf(server)('/v1/files', {
      method: 'POST',
      body: Buffer.from(bytes),
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return ((await response.json()) as { fileId: string }).fileId
  }
  const open = async (server: ParseServer, fileId: string) => {
    const response = await requestOf(server)('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId }),
    })
    return {
      status: response.status,
      sessionId: ((await response.json()) as { sessionId: string }).sessionId,
    }
  }
  const add = async (): Promise<ParseServer> => {
    const dataDir = await mkdtemp(join(tmpdir(), 'journal-'))
    dirs.push(dataDir)
    const server = await createParseServer({
      dataDir,
      mysql: { host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath },
      artifactBackend: 'catalog',
      parserVersion: '0.1.0',
      parserFingerprint: 'journal-test',
      maxParseJobs: 1,
    })
    servers.push(server)
    return server
  }
  // Both instances start (and load the journal) before the session row exists,
  // so the second one must resolve it lazily from MySQL.
  const builder = await add()
  const reader = await add()
  return { database, builder, reader, requestOf, upload, open }
}

describe.skipIf(!socketPath)('cross-instance waiter journal over real MySQL', () => {
  it('attaches read-only to another instance waiter without starting a build or deleting it', async () => {
    const env = await createEnvironment()
    const fileId = await env.upload(env.builder, await createBlankPptx())
    const pause = pauseBeforeDone()
    const session = await env.open(env.builder, fileId)
    expect(session.status).toBe(202)
    try {
      await Promise.race([
        pause.entered.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('build never paused')), 15_000),
        ),
      ])
      // The reader never saw this session until now: it resolves the durable row
      // from MySQL and serves it read-only.
      const remote = await env.requestOf(env.reader)(`/v1/sessions/${session.sessionId}`)
      expect(remote.status).toBe(200)
      const body = (await remote.json()) as { state: string; previewable?: boolean }
      expect(['queued', 'building']).toContain(body.state)
      expect(body.previewable ?? false).toBe(false)
      const health = (await (await env.requestOf(env.reader)('/v1/health')).json()) as {
        artifacts: { buildsStarted: number; sourceParsesStarted: number }
      }
      expect(health.artifacts.buildsStarted).toBe(0)
      expect(health.artifacts.sourceParsesStarted).toBe(0)
      const beat = await env.requestOf(env.reader)(`/v1/sessions/${session.sessionId}/heartbeat`, {
        headers: { Prefer: 'respond-async' },
        method: 'POST',
      })
      expect(beat.status).toBe(200)
      // Closing the remote reading view must not delete the builder's row.
      const closed = await env.requestOf(env.reader)(`/v1/sessions/${session.sessionId}`, {
        method: 'DELETE',
      })
      expect(closed.status).toBe(204)
      const owner = await env.requestOf(env.builder)(`/v1/sessions/${session.sessionId}`)
      expect(owner.status).toBe(200)
    } finally {
      pause.blocked.resolve()
    }
    const readyDeadline = Date.now() + 20_000
    for (;;) {
      const response = await env.requestOf(env.builder)(`/v1/sessions/${session.sessionId}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { state: string }
      if (body.state === 'ready') break
      if (body.state === 'failed') throw new Error('shared build failed after release')
      if (Date.now() > readyDeadline) throw new Error('shared build never became ready')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // The remote reader cannot attach to the ready generation without the same
    // data directory; the journal attach is a status/first-screen view.
    const afterReady = await env.requestOf(env.reader)(`/v1/sessions/${session.sessionId}`)
    expect([200, 404]).toContain(afterReady.status)
  })
})
