import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createBackupManifest, verifyRestore } from '../src/backup-manifest'
import { artifactKey } from '../src/artifact-store'
import { ArtifactSession } from '../src/artifact-session'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

describe.skipIf(!socketPath)('backup dependency graph over real MySQL', () => {
  it('captures artifact dependency rows in the manifest and verifies them on restore', async () => {
    const database = `genoffice_backup_deps_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'backup-deps-'))
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath }
    const server = await createParseServer({
      dataDir, mysql: config, artifactBackend: 'catalog',
      parserVersion: '0.1.0', parserFingerprint: 'backup-deps-test',
    })
    servers.push(server)
    const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
    const uploaded = await request('/v1/files', {
      method: 'POST', body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = await uploaded.json() as { fileId: string }
    const opened = await request('/v2/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    const { sessionId } = await opened.json() as { sessionId: string }
    const deadline = Date.now() + 20_000
    for (;;) {
      const status = await request(`/v2/sessions/${sessionId}`)
      const body = await status.json() as { state: string }
      if (body.state === 'ready') break
      if (body.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const bundle = await request(`/v2/sessions/${sessionId}/bundle`)
    expect(bundle.status, await bundle.clone().text()).toBe(200)
    const modelKey = artifactKey(ArtifactSession.identity({
      fileId, format: 'pptx', parserVersion: '0.1.0', parserFingerprint: 'backup-deps-test',
    }))
    const manifest = await createBackupManifest({ dataDir, db: server.db! })
    const dependencies = manifest.catalog.dependencies ?? []
    expect(dependencies).toEqual(expect.arrayContaining([
      { artifactKey: modelKey, type: 'file', id: fileId },
    ]))
    expect(dependencies.some((row) => row.type === 'artifact' && row.id === modelKey)).toBe(true)
    const report = await verifyRestore({ dataDir, manifest, db: server.db! })
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
  }, 90_000)
})
