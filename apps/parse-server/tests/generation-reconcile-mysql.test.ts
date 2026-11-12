import { drainCleanups } from './helpers/cleanup'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { MysqlArtifactCatalog, artifactGenerationPath } from '../src/artifact-catalog'
import { artifactKey } from '../src/artifact-store'
import { MysqlDatabase } from '../src/mysql'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

describe.skipIf(!socketPath)('startup orphan-generation reconcile over real MySQL', () => {
  it('removes aged unregistered generations but keeps keys that still have a catalog row', async () => {
    const database = `genoffice_reconcile_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'reconcile-mysql-'))
    const config = {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      password: '',
      database,
      socketPath,
    }
    const db = new MysqlDatabase(config)
    cleanups.push(async () => {
      await db.close().catch(() => undefined)
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    await db.init()
    const fileId = 'a'.repeat(64)
    await db.pool.execute(
      'INSERT INTO parse_files (file_id, sha256, size, format, created_at) VALUES (?, ?, 0, ?, ?)',
      [fileId, fileId, 'pptx', new Date().toISOString()],
    )
    const identity = {
      fileId,
      format: 'pptx' as const,
      parserFingerprint: 'reconcile-test',
      schemaVersion: 2,
      options: {},
    }
    const modelKey = artifactKey(identity)
    const catalog = new MysqlArtifactCatalog(db)
    const claim = await catalog.claim(identity, 'reconcile-owner')
    expect(claim.kind).toBe('acquired')
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    // A building row exists for modelKey, so its aged generation dir is protected.
    const known = join(dataDir, artifactGenerationPath(modelKey, 1))
    await mkdir(known, { recursive: true })
    await writeFile(join(known, 'units.bin'), 'bytes')
    await utimes(known, old, old)
    // No catalog row for this key: the directory is an orphan.
    const orphanKey = 'b'.repeat(64)
    const orphan = join(dataDir, artifactGenerationPath(orphanKey, 1))
    await mkdir(orphan, { recursive: true })
    await writeFile(join(orphan, 'units.bin'), 'bytes')
    await utimes(orphan, old, old)

    const server: ParseServer = await createParseServer({
      dataDir,
      mysql: config,
      artifactBackend: 'catalog',
      parserFingerprint: 'reconcile-test',
    })
    cleanups.push(() => server.close())
    try {
      await expect(readdir(known)).resolves.toBeDefined()
      await expect(readdir(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
      const health = (await (await fetch(server.url + '/v1/health')).json()) as {
        maintenance: {
          startupReconcile: { removedGenerations: number; retainedGenerations: number } | null
        }
      }
      expect(health.maintenance.startupReconcile).toMatchObject({
        removedGenerations: 1,
        retainedGenerations: 1,
      })
    } finally {
      await server.close()
    }
  }, 60_000)
})
