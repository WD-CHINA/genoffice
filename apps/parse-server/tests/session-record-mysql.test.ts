import { drainCleanups } from './helpers/cleanup'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise'
import { afterEach, describe, expect, it } from 'vitest'
import { ArtifactSession } from '../src/artifact-session'
import { artifactKey } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

const socketPath = process.env.PARSE_TEST_MYSQL_SOCKET
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  await drainCleanups(cleanups)
})

const OLD_SESSIONS_DDL = `
  CREATE TABLE parse_sessions (
    id CHAR(36) NOT NULL PRIMARY KEY,
    file_id VARCHAR(64) NOT NULL,
    width INT NOT NULL,
    parser_version VARCHAR(64) NOT NULL,
    base_url TEXT NOT NULL,
    model JSON NOT NULL,
    fonts JSON NOT NULL,
    created_at BIGINT NOT NULL,
    last_used BIGINT NOT NULL,
    KEY idx_parse_sessions_file (file_id),
    KEY idx_parse_sessions_used (last_used)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

describe.skipIf(!socketPath)('parse_sessions staged migration over real MySQL', () => {
  it('adds artifact_key/expires_at to an old table, persists them, survives restart and exposes them on v1', async () => {
    const database = `genoffice_sessions_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'session-record-'))
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    // Simulate a deployment created by an older release: only the legacy columns.
    await admin.query(`USE ${database}`)
    await admin.query(OLD_SESSIONS_DDL)
    await admin.query('USE mysql')

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
        parserVersion: '0.1.0',
        parserFingerprint: 'session-record-test',
      })
      servers.push(server)
      return server
    }
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const first = await start()
    const rows = async (sql: string, values: unknown[] = []) =>
      (await first.db!.pool.query<RowDataPacket[]>(sql, values))[0]
    const columns = await rows(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'parse_sessions'`,
      [database],
    )
    const names = columns.map((row) => String(row.COLUMN_NAME))
    for (const column of ['artifact_key', 'expires_at', 'base_url', 'model', 'fonts'])
      expect(names).toContain(column)

    const uploaded = await request(first)('/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    expect(uploaded.status, await uploaded.clone().text()).toBe(201)
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const opened = await request(first)('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(opened.status, await opened.clone().text()).toBe(201)
    const { sessionId } = (await opened.json()) as { sessionId: string }
    const expectedKey = artifactKey(
      ArtifactSession.identity({
        fileId,
        format: 'pptx',
        parserVersion: '0.1.0',
        parserFingerprint: 'session-record-test',
      }),
    )
    const before = (
      await rows(
        'SELECT artifact_key, expires_at, last_used, model, fonts, base_url FROM parse_sessions WHERE id = ?',
        [sessionId],
      )
    )[0]
    expect(before.artifact_key).toBe(expectedKey)
    expect(Number(before.expires_at)).toBe(Number(before.last_used) + 30 * 60_000)
    // New records reference the artifact: the legacy per-session copies stay empty.
    expect(before.model).toBeNull()
    expect(before.fonts).toBeNull()
    expect(before.base_url).toBeNull()
    // ...while v1 responses still return model/fonts by reading the artifact.
    const v1 = (await (await request(first)(`/v1/sessions/${sessionId}`)).json()) as {
      model: { format: string; unitCount: number }
      fonts: unknown[]
    }
    expect(v1.model.format).toBe('pptx')
    expect(v1.model.unitCount).toBeGreaterThan(0)
    expect(Array.isArray(v1.fonts)).toBe(true)

    const status = (await (await request(first)(`/v1/sessions/${sessionId}`)).json()) as {
      artifactKey: string
      expiresAt: number
      state: string
    }
    expect(status).toMatchObject({ state: 'ready', artifactKey: expectedKey })
    // The GET itself touches the record, so the deadline only moves forward.
    expect(status.expiresAt).toBeGreaterThanOrEqual(Number(before.expires_at))

    // A heartbeat/GET touch refreshes last_used and the idle deadline.
    await new Promise((resolve) => setTimeout(resolve, 5))
    await request(first)(`/v1/sessions/${sessionId}`)
    const touched = (
      await rows('SELECT expires_at, last_used FROM parse_sessions WHERE id = ?', [sessionId])
    )[0]
    expect(Number(touched.last_used)).toBeGreaterThanOrEqual(Number(before.last_used))
    expect(Number(touched.expires_at)).toBe(Number(touched.last_used) + 30 * 60_000)

    // Restart: the record is reloaded from MySQL with the new columns intact.
    await first.close()
    const second = await start()
    const restored = (await (await request(second)(`/v1/sessions/${sessionId}`)).json()) as {
      artifactKey: string
      expiresAt: number
      state: string
    }
    expect(restored).toMatchObject({ state: 'ready', artifactKey: expectedKey })
    expect(restored.expiresAt).toBeGreaterThanOrEqual(Number(touched.expires_at))
    const reloaded = (
      await second.db!.pool.query<RowDataPacket[]>(
        'SELECT artifact_key, expires_at, last_used FROM parse_sessions WHERE id = ?',
        [sessionId],
      )
    )[0][0]
    expect(reloaded.artifact_key).toBe(expectedKey)
    expect(Number(reloaded.expires_at)).toBe(Number(reloaded.last_used) + 30 * 60_000)
  }, 60_000)
})
