import { randomUUID } from 'node:crypto'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { artifactKey, type ArtifactIdentity } from '../src/artifact-store'
import { MysqlArtifactCatalog } from '../src/artifact-catalog'
import { MysqlDatabase } from '../src/mysql'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

const fileId = 'a'.repeat(64)
const modelIdentity: ArtifactIdentity = {
  fileId, format: 'pptx', parserFingerprint: 'dependency-test', schemaVersion: 2, options: {},
}
const bundleIdentity: ArtifactIdentity = {
  fileId, format: 'pptx', parserFingerprint: 'dependency-test', schemaVersion: 2,
  options: { purpose: 'offline-bundle', modelArtifactKey: artifactKey(modelIdentity) },
}
const summary = { bytes: 100, unitCount: 2, manifestSha256: 'b'.repeat(64) }

describe.skipIf(!socketPath)('artifact dependency graph over real MySQL', () => {
  it('records ready-artifact file dependencies and derived-bundle model dependencies', async () => {
    const database = `genoffice_deps_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const db = new MysqlDatabase({
      host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath,
    })
    cleanups.push(async () => {
      await db.close().catch(() => undefined)
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
    })
    await db.init()
    await db.pool.execute(
      'INSERT INTO parse_files (file_id, sha256, size, format, created_at) VALUES (?, ?, 0, ?, ?)',
      [fileId, fileId, 'pptx', new Date().toISOString()],
    )
    const catalog = new MysqlArtifactCatalog(db)
    for (const identity of [modelIdentity, bundleIdentity]) {
      const claim = await catalog.claim(identity, 'dependency-owner')
      if (claim.kind !== 'acquired') throw new Error('expected an acquired lease')
      expect(await catalog.complete(claim.lease, summary)).toBe(true)
    }
    const modelKey = artifactKey(modelIdentity)
    const bundleKey = artifactKey(bundleIdentity)
    // complete() records the source dependency in the same transaction.
    expect(await catalog.dependenciesOf(modelKey)).toEqual([{ type: 'file', id: fileId }])
    expect(await catalog.dependenciesOf(bundleKey)).toEqual([{ type: 'file', id: fileId }])
    expect(await catalog.hasDependencyOnFile(fileId)).toBe(true)

    // Derived bundle -> model generation edge (recorded by ArtifactSession).
    expect(await catalog.recordDependency(bundleKey, 'artifact', modelKey)).toBe(true)
    expect(await catalog.dependenciesOf(bundleKey)).toEqual([
      { type: 'artifact', id: modelKey },
      { type: 'file', id: fileId },
    ])
    expect(await catalog.recordDependency(bundleKey, 'artifact', modelKey)).toBe(false)

    // Removing the directory row cascades its dependency rows (FK), so a
    // tombstoned/archived artifact cannot keep a source alive by accident.
    await db.pool.execute('DELETE FROM parse_artifacts WHERE artifact_key = ?', [bundleKey])
    expect(await catalog.dependenciesOf(bundleKey)).toEqual([])

    await expect(catalog.recordDependency('not-a-key', 'file', fileId))
      .rejects.toThrow(/invalid artifact dependency/)
  }, 60_000)
})
