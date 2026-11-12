import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackupManifest, verifyRestore } from '../src/backup-manifest'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

describe.skipIf(!socketPath)('cross-instance backup over a shared dataDir + MySQL catalog', () => {
  it('lets a second instance snapshot and verify a deployment built by the first', async () => {
    const database = `genoffice_backup_nodes_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'backup-nodes-'))
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
        parserFingerprint: 'backup-nodes-test',
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
    const { sessionId } = (await opened.json()) as { sessionId: string }
    const deadline = Date.now() + 20_000
    for (;;) {
      const state = (await (await request(a)(`/v2/sessions/${sessionId}`)).json()) as {
        state: string
      }
      if (state.state === 'ready') break
      if (state.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    // B owns a different process but the same deployment: snapshot with B's
    // catalog connection while A keeps serving.
    const manifest = await createBackupManifest({ dataDir, db: b.db! })
    expect(manifest.catalog.artifacts.length).toBeGreaterThan(0)
    expect((manifest.catalog.dependencies ?? []).length).toBeGreaterThan(0)
    const report = await verifyRestore({ dataDir, manifest, db: a.db! })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
  }, 90_000)
})
