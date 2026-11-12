import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
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

describe.skipIf(!socketPath)('backend rollback safety over real MySQL', () => {
  it('local backend GC keeps catalog-referenced and saved sources after a catalog->local rollback', async () => {
    const database = `genoffice_rollback_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'rollback-'))
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
    const start = async (artifactBackend: 'catalog' | 'local'): Promise<ParseServer> => {
      const server = await createParseServer({
        dataDir,
        mysql: config,
        artifactBackend,
        parserVersion: '0.1.0',
        parserFingerprint: 'rollback-test',
        // Aggressive TTL makes any missing reference visible immediately.
        ...(artifactBackend === 'local' ? { contentTtlMs: 0 } : {}),
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const upload = async (server: ParseServer): Promise<string> => {
      const response = await request(server)('/v1/files', {
        method: 'POST',
        body: Buffer.from(await createBlankPptx()),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      return ((await response.json()) as { fileId: string }).fileId
    }
    const openReady = async (server: ParseServer, fileId: string): Promise<string> => {
      const opened = await request(server)('/v2/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
      expect([201, 202]).toContain(opened.status)
      const { sessionId } = (await opened.json()) as { sessionId: string }
      const deadline = Date.now() + 20_000
      for (;;) {
        const status = await request(server)(`/v2/sessions/${sessionId}`)
        expect(status.status).toBe(200)
        const body = (await status.json()) as { state: string }
        if (body.state === 'ready') return sessionId
        if (body.state === 'failed') throw new Error('catalog build failed')
        if (Date.now() > deadline) throw new Error('session did not become ready')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    // Catalog-backed release: one saved library file and one session-only file.
    const first = await start('catalog')
    const savedFile = await upload(first)
    const sessionOnlyFile = await upload(first)
    const saved = await request(first)('/v2/library', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: savedFile, displayName: 'rollback-saved.pptx' }),
    })
    expect([200, 201]).toContain(saved.status)
    await openReady(first, savedFile)
    await openReady(first, sessionOnlyFile)

    // Roll back to the local backend but keep MySQL: catalog rows and the saved
    // library marker must still fence local GC from deleting either source.
    const second = await start('local')
    await second.gc()
    for (const fileId of [savedFile, sessionOnlyFile]) {
      const content = await request(second)(`/v1/files/${fileId}/content`)
      expect(content.status, `source ${fileId.slice(0, 8)} must survive rollback GC`).toBe(200)
      await content.arrayBuffer()
    }
    const library = (await (await request(second)('/v2/library')).json()) as {
      items: Array<{ fileId: string }>
    }
    expect(library.items.some((entry) => entry.fileId === savedFile)).toBe(true)
    // The generation directories produced by the catalog release are still on
    // disk and are never touched by the local backend's GC.
    await expect(stat(join(dataDir, 'artifacts'))).resolves.toBeTruthy()
    expect(servers.length).toBe(2)
  }, 90_000)
})
