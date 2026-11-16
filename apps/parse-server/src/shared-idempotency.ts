import type { RowDataPacket } from 'mysql2/promise'
import type { MysqlDatabase } from './mysql'

/**
 * Durable `Idempotency-Key` ledger (plan §7): the in-process map is a fast replay
 * cache, this table is the cross-instance/restart truth for async session creation.
 * A pending row has `body = NULL`; the winner fills it, waiters replay it.
 */
export class SharedIdempotencyStore {
  constructor(
    private readonly db: MysqlDatabase,
    private readonly maxTtlMs = 24 * 60 * 60_000,
  ) {}

  private validate(scope: string, key: string): void {
    if (!/^[a-z0-9:_-]{1,32}$/.test(scope)) throw new Error('invalid idempotency scope')
    if (
      typeof key !== 'string' ||
      key.length < 8 ||
      key.length > 128 ||
      [...key].some((character) => {
        const code = character.charCodeAt(0)
        return code < 0x20 || code === 0x7f
      })
    )
      throw new Error('invalid idempotency key')
  }

  async lookup(
    scope: string,
    key: string,
  ): Promise<{ body?: unknown; pending: boolean } | undefined> {
    this.validate(scope, key)
    await this.db.pool.query(
      'DELETE FROM parse_idempotency WHERE scope = ? AND idempotency_key = ? AND expires_at <= ?',
      [scope, key, Date.now()],
    )
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT body FROM parse_idempotency WHERE scope = ? AND idempotency_key = ? LIMIT 1',
      [scope, key],
    )
    const row = rows[0]
    if (!row) return undefined
    if (row.body === null || row.body === undefined) return { pending: true }
    try {
      return {
        pending: false,
        body: typeof row.body === 'string' ? JSON.parse(row.body) : row.body,
      }
    } catch {
      return { pending: true }
    }
  }

  /** Insert a pending claim; false when another instance owns the key. */
  async claim(scope: string, key: string, ttlMs: number): Promise<boolean> {
    this.validate(scope, key)
    const now = Date.now()
    const ttl = Math.min(Math.max(1, ttlMs), this.maxTtlMs)
    const [result] = await this.db.pool.query(
      `INSERT IGNORE INTO parse_idempotency
         (scope, idempotency_key, body, created_at, expires_at)
       VALUES (?, ?, NULL, ?, ?)`,
      [scope, key, now, now + ttl],
    )
    return (result as { affectedRows: number }).affectedRows > 0
  }

  async complete(scope: string, key: string, body: unknown): Promise<void> {
    this.validate(scope, key)
    await this.db.pool.query(
      `UPDATE parse_idempotency SET body = ?, expires_at = GREATEST(expires_at, ?)
       WHERE scope = ? AND idempotency_key = ?`,
      [JSON.stringify(body), Date.now() + 60_000, scope, key],
    )
  }

  /** Store or replace a completed body (late writer / stale pending takeover). */
  async remember(scope: string, key: string, body: unknown, ttlMs: number): Promise<void> {
    this.validate(scope, key)
    const now = Date.now()
    const ttl = Math.min(Math.max(1, ttlMs), this.maxTtlMs)
    await this.db.pool.query(
      `INSERT INTO parse_idempotency (scope, idempotency_key, body, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE body=VALUES(body), expires_at=VALUES(expires_at)`,
      [scope, key, JSON.stringify(body), now, now + ttl],
    )
  }

  async release(scope: string, key: string): Promise<void> {
    this.validate(scope, key)
    await this.db.pool.query(
      'DELETE FROM parse_idempotency WHERE scope = ? AND idempotency_key = ? AND body IS NULL',
      [scope, key],
    )
  }

  async close(): Promise<void> {
    /* row ownership stays with the database */
  }
}
