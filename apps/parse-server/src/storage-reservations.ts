import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { MysqlDatabase } from './mysql'

/** A process lost its shared reservation lease; failing closed prevents quota overselling. */
export class StorageAdmissionLeaseLostError extends Error {
  readonly code = 'storage_admission_lease_lost'
  constructor() {
    super('shared storage admission lease expired; retry the write')
    this.name = 'StorageAdmissionLeaseLostError'
  }
}

/**
 * Cross-process view of bytes reserved by writers that have not yet reached disk.
 * `usedBytes()` already sees published files from every process; this ledger covers
 * the gap between admission and publication.
 */
export interface SharedStorageLedger {
  /** Round small writes up to this block so uploads do not hit SQL per chunk. */
  readonly blockBytes: number
  readonly leaseMs: number
  /** Serializes the read-check-publish sequence across processes. */
  withExclusive<T>(work: () => Promise<T>): Promise<T>
  reservedBytes(): Promise<number>
  /** Idempotent absolute assignment; also renews the lease. */
  set(id: string, bytes: number): Promise<void>
  /** Returns false when the row was already reclaimed as stale. */
  renew(id: string): Promise<boolean>
  release(id: string): Promise<void>
  /** Drop rows left by crashed processes; returns the number removed. */
  reconcile(): Promise<number>
  /** Release every live row owned by this instance on graceful shutdown. */
  close(): Promise<void>
}

function safeBytes(value: unknown): number {
  const bytes = Number(value)
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid shared storage reservation')
  return bytes
}

/** MySQL advisory lock + leased rows; no process-local state participates in admission. */
export class SqlStorageReservations implements SharedStorageLedger {
  readonly blockBytes: number
  readonly leaseMs: number
  readonly owner = randomUUID()
  private readonly lockName: string
  private readonly lockTimeoutSec: number
  /** Re-entrant calls already hold this process's admission lock. */
  private readonly inLock = new AsyncLocalStorage<boolean>()

  constructor(private readonly db: MysqlDatabase, options: {
    blockBytes?: number
    leaseMs?: number
    lockTimeoutMs?: number
  } = {}) {
    this.blockBytes = options.blockBytes ?? 1024 * 1024
    this.leaseMs = options.leaseMs ?? 5 * 60_000
    const lockTimeoutMs = options.lockTimeoutMs ?? 10_000
    if (!Number.isSafeInteger(this.blockBytes) || this.blockBytes < 1 || this.blockBytes > 64 * 1024 ** 2)
      throw new Error('invalid shared storage block size')
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 10_000 || this.leaseMs > 60 * 60_000)
      throw new Error('invalid shared storage lease duration')
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1000 || lockTimeoutMs > 120_000)
      throw new Error('invalid shared storage lock timeout')
    this.lockTimeoutSec = Math.max(1, Math.ceil(lockTimeoutMs / 1000))
    // GET_LOCK names are server-wide and capped at 64 characters; scope them to
    // a digest of the database so unrelated deployments cannot block each other.
    const scope = createHash('sha256').update(db.config.database).digest('hex').slice(0, 24)
    this.lockName = `genoffice:storage-admission:${scope}`
  }

  async init(): Promise<void> {
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_storage_reservations (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        owner CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        bytes BIGINT UNSIGNED NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        KEY idx_storage_reservations_expiry (expires_at_ms),
        KEY idx_storage_reservations_owner (owner)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
  }

  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    // GET_LOCK is per connection; a second connection in the same process would
    // wait for the first one forever. The outer lock already serializes us.
    if (this.inLock.getStore()) return work()
    const connection = await this.db.pool.getConnection()
    let locked = false
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT GET_LOCK(?, ?) AS acquired', [this.lockName, this.lockTimeoutSec],
      )
      if (rows[0]?.acquired !== 1) throw new Error('shared storage admission lock timeout')
      locked = true
      // Expired rows are invisible to reservedBytes(); remove them under the lock
      // so a crashed process cannot keep its pre-publication bytes fenced forever.
      await connection.query('DELETE FROM parse_storage_reservations WHERE expires_at_ms <= ?', [Date.now()])
      return await this.inLock.run(true, work)
    } finally {
      if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [this.lockName]).catch(() => undefined)
      connection.release()
    }
  }

  async reservedBytes(): Promise<number> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT COALESCE(SUM(bytes), 0) AS total FROM parse_storage_reservations WHERE expires_at_ms > ?',
      [Date.now()],
    )
    return safeBytes(rows[0]?.total ?? 0)
  }

  async set(id: string, bytes: number): Promise<void> {
    const total = safeBytes(bytes)
    const now = Date.now()
    await this.db.pool.query(
      `INSERT INTO parse_storage_reservations (id, owner, bytes, expires_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE bytes = VALUES(bytes), expires_at_ms = VALUES(expires_at_ms),
         updated_at_ms = VALUES(updated_at_ms)`,
      [id, this.owner, total, now + this.leaseMs, now],
    )
  }

  async renew(id: string): Promise<boolean> {
    const now = Date.now()
    const [result] = await this.db.pool.query<ResultSetHeader>(
      `UPDATE parse_storage_reservations SET expires_at_ms = ?, updated_at_ms = ?
       WHERE id = ? AND expires_at_ms > ?`,
      [now + this.leaseMs, now, id, now],
    )
    return result.affectedRows === 1
  }

  async release(id: string): Promise<void> {
    await this.db.pool.query('DELETE FROM parse_storage_reservations WHERE id = ?', [id])
  }

  async reconcile(): Promise<number> {
    const [result] = await this.db.pool.query<ResultSetHeader>(
      'DELETE FROM parse_storage_reservations WHERE expires_at_ms <= ?', [Date.now()],
    )
    return result.affectedRows
  }

  async close(): Promise<void> {
    await this.db.pool.query('DELETE FROM parse_storage_reservations WHERE owner = ?', [this.owner])
  }
}
