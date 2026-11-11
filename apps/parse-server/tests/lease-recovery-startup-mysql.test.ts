import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'
import { ArtifactSession } from '../src/artifact-session'
import { artifactKey } from '../src/artifact-store'
import { MysqlDatabase } from '../src/mysql'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

describe.skipIf(!socketPath)('startup lease recovery with isolated real MySQL', () => {
  it('requeues an expired building lease during startup and reports it in health', async () => {
    const database = `genoffice_lease_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    cleanups.push(async () => { await admin.query(`DROP DATABASE ${database}`); await admin.end() })
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath }
    const seed = new MysqlDatabase(config)
    await seed.init()
    cleanups.push(async () => { await seed.close() })

    const fileId = 'c'.repeat(64)
    const identity = ArtifactSession.identity({
      fileId, format: 'pptx', parserVersion: '0.1.0', parserFingerprint: 'lease-recovery-test',
    })
    const key = artifactKey(identity)
    await seed.pool.execute(
      `INSERT INTO parse_files (file_id, sha256, size, format, created_at) VALUES (?, ?, 0, 'pptx', ?)`,
      [fileId, fileId, new Date().toISOString()])
    await seed.pool.execute(
      `INSERT INTO parse_artifacts
         (artifact_key, file_id, identity, state, generation, last_access_at)
       VALUES (?, ?, ?, 'building', 1, ?)`,
      [key, fileId, JSON.stringify(identity), Date.now()])
    const jobId = randomUUID()
    await seed.pool.execute(
      `INSERT INTO parse_jobs
         (job_id, artifact_key, state, attempt, generation, lease_owner, lease_until)
       VALUES (?, ?, 'building', 1, 1, 'dead-builder', 0)`,
      [jobId, key])

    const dataDir = await mkdtemp(join(tmpdir(), 'lease-recovery-'))
    cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
    const server: ParseServer = await createParseServer({
      dataDir, token: 'secret', parserVersion: '0.1.0', parserFingerprint: 'lease-recovery-test',
      mysql: config, artifactBackend: 'catalog',
    })
    cleanups.push(() => server.close())
    const health = (await (await fetch(server.url + '/v1/health', {
      headers: { Authorization: 'Bearer secret' },
    })).json()) as { maintenance: { leaseRecovery: unknown } }
    expect(health.maintenance.leaseRecovery).toEqual({ examined: 1, requeued: 1 })

    const [jobs] = await seed.pool.query(
      'SELECT state, lease_owner, lease_until FROM parse_jobs WHERE job_id = ?', [jobId])
    expect((jobs as Array<{ state: string; lease_owner: string | null; lease_until: number | null }>)[0])
      .toMatchObject({ state: 'queued', lease_owner: null, lease_until: null })
    const [artifacts] = await seed.pool.query(
      'SELECT state FROM parse_artifacts WHERE artifact_key = ?', [key])
    expect((artifacts as Array<{ state: string }>)[0].state).toBe('queued')
  })
})
