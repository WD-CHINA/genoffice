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
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

describe.skipIf(!socketPath)('plan §5 library/source columns over real MySQL', () => {
  it('records scope/retention, soft-deletes history, resurrects and purges tombstones', async () => {
    const database = `genoffice_schema_${randomUUID().replaceAll('-', '')}`
    const admin: Connection = await mysql.createConnection({ socketPath, user: 'root' })
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`)
    const dataDir = await mkdtemp(join(tmpdir(), 'schema-columns-'))
    const servers: ParseServer[] = []
    cleanups.push(async () => {
      await Promise.all(servers.map((server) => server.close().catch(() => undefined)))
      await admin.query(`DROP DATABASE ${database}`).catch(() => undefined)
      await admin.end()
      await rm(dataDir, { recursive: true, force: true })
    })
    const config = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database, socketPath }
    const start = async (): Promise<ParseServer> => {
      const server = await createParseServer({ dataDir, mysql: config })
      servers.push(server)
      return server
    }
    const first = await start()
    const request = (server: ParseServer) => (path: string, init?: RequestInit) =>
      fetch(server.url + path, init)
    const uploaded = await request(first)('/v1/files', {
      method: 'POST', body: Buffer.from(await createBlankPptx()),
    })
    expect(uploaded.status).toBe(201)
    const { fileId } = await uploaded.json() as { fileId: string }
    const sourceRows = async () => (await first.db!.pool.query<RowDataPacket[]>(
      'SELECT storage_state, verified_at FROM parse_files WHERE file_id = ?', [fileId],
    ))[0]
    const source = await sourceRows()
    expect(source[0].storage_state).toBe('stored')
    expect(Number(source[0].verified_at)).toBeGreaterThan(0)

    const save = async () => {
      const response = await request(first)('/v2/library', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, displayName: 'plan5-saved.pptx' }),
      })
      expect([200, 201]).toContain(response.status)
      return (await response.json()) as { id: string }
    }
    const entry = await save()
    const row = async () => (await first.db!.pool.query<RowDataPacket[]>(
      'SELECT library_scope, retention, deleted_at FROM library_entries WHERE id = ?', [entry.id],
    ))[0]
    expect((await row())[0].library_scope).toBe('instance')
    expect((await row())[0].retention).toBe('saved')
    expect((await row())[0].deleted_at).toBeNull()

    const removed = await request(first)(`/v2/library/${entry.id}`, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    // Soft delete keeps the row for audit/reconciliation but hides it and stops
    // protecting the source from GC.
    const tombstone = await row()
    expect(tombstone[0].deleted_at).not.toBeNull()
    const listed = await (await request(first)('/v2/library')).json() as { items: unknown[] }
    expect(listed.items).toHaveLength(0)

    const resurrected = await save()
    const active = (await first.db!.pool.query<RowDataPacket[]>(
      'SELECT deleted_at FROM library_entries WHERE file_id = ?', [fileId],
    ))[0]
    expect(active).toHaveLength(1)
    expect(active[0].deleted_at).toBeNull()
    const relisted = await (await request(first)('/v2/library')).json() as { items: unknown[] }
    expect(relisted.items).toHaveLength(1)
    // The tombstone cleared its file_id reference, so re-saving creates a fresh row.
    expect(resurrected.id).not.toBe(entry.id)

    // Tombstones are purged after the retention window on the next startup.
    await request(first)(`/v2/library/${entry.id}`, { method: 'DELETE' })
    await first.db!.pool.query(
      'UPDATE library_entries SET deleted_at = ? WHERE id = ?',
      [Date.now() - 31 * 24 * 60 * 60_000, entry.id],
    )
    await first.close()
    const second = await start()
    const purged = (await second.db!.pool.query<RowDataPacket[]>(
      'SELECT id FROM library_entries WHERE id = ?', [entry.id],
    ))[0]
    expect(purged).toHaveLength(0)
  }, 90_000)
})
