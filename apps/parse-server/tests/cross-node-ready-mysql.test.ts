import { drainCleanups } from './helpers/cleanup'
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
afterEach(async () => {
  await drainCleanups(cleanups)
})

async function buildsStarted(server: ParseServer): Promise<number> {
  const health = (await (await fetch(server.url + '/v1/health')).json()) as {
    artifacts: { buildsStarted: number }
  }
  return health.artifacts.buildsStarted
}

describe.skipIf(!socketPath)('cross-node ready attach over a shared dataDir + catalog', () => {
  it('serves a ready model and its units from a second instance without rebuilding', async () => {
    const database = `genoffice_cross_node_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'cross-node-'))
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
    // Two independent processes sharing the documented deployment precondition:
    // one dataDir + one catalog. Ready bytes are immutable generations on disk.
    const start = async (): Promise<ParseServer> => {
      const server = await createParseServer({
        dataDir,
        mysql: config,
        artifactBackend: 'catalog',
        parserVersion: '0.1.0',
        parserFingerprint: 'cross-node-test',
      })
      servers.push(server)
      return server
    }
    const a = await start()
    const b = await start()
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const uploaded = await request(a)('/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const opened = await request(a)('/v2/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect([201, 202]).toContain(opened.status)
    const { sessionId } = (await opened.json()) as { sessionId: string }
    const deadline = Date.now() + 25_000
    for (;;) {
      const status = await request(a)(`/v2/sessions/${sessionId}`)
      const body = (await status.json()) as { state: string; artifactKey?: string }
      if (body.state === 'ready') {
        expect(body.artifactKey).toMatch(/^[a-f0-9]{64}$/)
        break
      }
      if (body.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(await buildsStarted(a)).toBe(1)
    expect(await buildsStarted(b)).toBe(0)

    // B finds the persisted session, opens the ready generation through the
    // catalog and serves a unit without building anything.
    const seenResponse = await request(b)(`/v2/sessions/${sessionId}`)
    expect(seenResponse.status).toBe(200)
    const seen = (await seenResponse.json()) as { state?: string; artifactKey?: string }
    expect(seen.state).toBe('ready')
    expect(seen.artifactKey).toMatch(/^[a-f0-9]{64}$/)
    const unitA = await request(a)(`/v2/sessions/${sessionId}/units/0`)
    const unitB = await request(b)(`/v2/sessions/${sessionId}/units/0`)
    expect(unitA.status).toBe(200)
    expect(unitB.status, await unitB.clone().text()).toBe(200)
    expect(await unitB.json()).toEqual(await unitA.json())
    expect(await buildsStarted(b)).toBe(0)

    // B could also build its own derived offline bundle, but that is a new
    // derived generation, not a model rebuild.
    const bundle = await request(b)(`/v2/sessions/${sessionId}/bundle`)
    expect(bundle.status, await bundle.clone().text()).toBe(200)
    expect(await buildsStarted(b)).toBe(1)
    const rows = (
      await b.db!.pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM parse_artifact_read_leases WHERE artifact_key IN
         (SELECT artifact_key FROM parse_artifacts WHERE file_id = ?)`,
        [fileId],
      )
    )[0]
    expect(Number(rows[0].n)).toBeGreaterThan(0)
  }, 90_000)
})
