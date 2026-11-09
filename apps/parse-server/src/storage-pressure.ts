import { createHash } from 'node:crypto'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { MysqlDatabase } from './mysql'

/** One shared pressure round, as seen by every instance. */
export interface PressureRound {
  round: number
  targetBytes: number
  reclaimedBytes: number
  remainingBytes: number
  expiresAt: number
  expired: boolean
}

/** Minimal round state for the eviction pass (no health-only fields). */
export interface SharedPressureState {
  round: number
  targetBytes: number
  reclaimedBytes: number
  remainingBytes: number
}

/**
 * A cross-process budget for pressure-driven cache reclamation. `request()`
 * itself is process-local (it runs inside the storage admission GET_LOCK), but
 * the *amount each fleet may reclaim* must be shared: without this ledger N
 * instances each reclaim the full target and overshoot by N times.
 *
 * The ledger has exactly one row per deployment. Every candidate is charged
 * with a single conditional UPDATE before its SQL retirement runs, so
 * `SUM(reclaimed) <= MAX(target)` holds globally without claims, leases,
 * heartbeats or startup reconciliation. A crashed process can only leave an
 * over-charge (fewer generations reclaimed than the target), never an
 * under-charge. All methods run *outside* the admission GET_LOCK.
 */
export interface SharedPressureLedger {
  /** Merge a pressure signal into the active round (MAX, never SUM). */
  register(bytes: number): Promise<SharedPressureState>
  /** Atomically pre-charge bytes against this round; false when the budget is gone. */
  reserve(round: number, bytes: number): Promise<boolean>
  /** Give a pre-charge back after a withdrawal that freed no bytes. */
  refund(round: number, bytes: number): Promise<void>
  /** Read-only view for health, without registering a new signal. */
  state(): Promise<PressureRound | null>
}

function positiveBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${label}`)
  return value
}

function safeNumber(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid shared pressure ${label}`)
  return parsed
}

export class SqlPressureLedger implements SharedPressureLedger {
  private readonly roundMs: number
  private readonly cooldownMs: number
  private readonly scope: string

  constructor(private readonly db: MysqlDatabase, options: {
    /** Lifetime of a pressure round; a new round is started after it expires. */
    roundMs?: number
    /** Once a round is satisfied, expire it after this shorter cooldown. */
    cooldownMs?: number
  } = {}) {
    this.roundMs = options.roundMs ?? 5 * 60_000
    this.cooldownMs = options.cooldownMs ?? 30_000
    if (!Number.isSafeInteger(this.roundMs) || this.roundMs < 1000 || this.roundMs > 2_147_483_647)
      throw new Error('invalid shared pressure round duration')
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 1000 ||
        this.cooldownMs > this.roundMs)
      throw new Error('invalid shared pressure cooldown duration')
    // Scope by database digest so two deployments sharing one MySQL server do
    // not consume each other's pressure budget.
    this.scope = createHash('sha256').update(db.config.database).digest('hex').slice(0, 32)
  }

  async init(): Promise<void> {
    await this.db.pool.query(`
      CREATE TABLE IF NOT EXISTS parse_storage_pressure (
        scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        round BIGINT UNSIGNED NOT NULL,
        target_bytes BIGINT UNSIGNED NOT NULL,
        reclaimed_bytes BIGINT UNSIGNED NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `)
  }

  async register(bytes: number): Promise<SharedPressureState> {
    const target = positiveBytes(bytes, 'shared pressure target')
    const connection = await this.db.pool.getConnection()
    try {
      await connection.beginTransaction()
      const now = Date.now()
      // No-op upsert makes the row exist before SELECT ... FOR UPDATE, so two
      // starting instances serialize on the same InnoDB row (the same pattern
      // as MysqlArtifactCatalog.claim). An initial row is already expired.
      await connection.query(`
        INSERT INTO parse_storage_pressure
          (scope, round, target_bytes, reclaimed_bytes, expires_at_ms, updated_at_ms)
        VALUES (?, 0, 0, 0, 0, ?)
        ON DUPLICATE KEY UPDATE scope = scope`, [this.scope, now])
      const [rows] = await connection.query<RowDataPacket[]>(`
        SELECT round, target_bytes, reclaimed_bytes, expires_at_ms
        FROM parse_storage_pressure WHERE scope = ? FOR UPDATE`, [this.scope])
      const row = rows[0]
      if (!row) throw new Error('shared pressure row missing after upsert')
      const previousRound = safeNumber(row.round, 'round')
      const previousTarget = safeNumber(row.target_bytes, 'target')
      const reclaimed = safeNumber(row.reclaimed_bytes, 'reclaimed')
      const previousExpiry = safeNumber(row.expires_at_ms, 'expiry')
      let round: number
      let targetBytes: number
      let currentReclaimed: number
      let expiresAt: number
      if (previousExpiry <= now) {
        // Expired or brand-new row: a fresh round with a fresh budget. Old
        // round numbers are never reused, so late reserves cannot charge it.
        round = previousRound + 1
        targetBytes = target
        currentReclaimed = 0
        expiresAt = now + this.roundMs
        await connection.query(`
          UPDATE parse_storage_pressure
          SET round = ?, target_bytes = ?, reclaimed_bytes = 0,
              expires_at_ms = ?, updated_at_ms = ?
          WHERE scope = ?`, [round, targetBytes, expiresAt, now, this.scope])
      } else {
        // Same pressure wave: several instances compute the same global
        // high-water deficit. MAX (not SUM) keeps the target a single number.
        round = previousRound
        targetBytes = Math.max(previousTarget, target)
        currentReclaimed = reclaimed
        // A satisfied round keeps its short cooldown expiry instead of being
        // extended by repeated signals; otherwise pressure would never be
        // re-evaluated until the full round TTL elapsed.
        expiresAt = reclaimed >= targetBytes
          ? previousExpiry
          : Math.max(previousExpiry, now + this.roundMs)
        await connection.query(`
          UPDATE parse_storage_pressure
          SET target_bytes = ?, expires_at_ms = ?, updated_at_ms = ?
          WHERE scope = ?`, [targetBytes, expiresAt, now, this.scope])
      }
      await connection.commit()
      return { round, targetBytes, reclaimedBytes: currentReclaimed,
        remainingBytes: Math.max(0, targetBytes - currentReclaimed) }
    } catch (error) {
      await connection.rollback().catch(() => undefined)
      throw error
    } finally {
      connection.release()
    }
  }

  async reserve(round: number, bytes: number): Promise<boolean> {
    const amount = positiveBytes(bytes, 'shared pressure charge')
    const now = Date.now()
    const [result] = await this.db.pool.query<ResultSetHeader>(`
      UPDATE parse_storage_pressure
      SET expires_at_ms = IF(reclaimed_bytes + ? >= target_bytes,
            LEAST(expires_at_ms, ?), expires_at_ms),
          reclaimed_bytes = reclaimed_bytes + ?,
          updated_at_ms = ?
      WHERE scope = ? AND round = ? AND expires_at_ms > ?
        AND reclaimed_bytes + ? <= target_bytes`,
    // The expiry expression is first, so it reads the pre-charge values and
    // does not depend on MySQL's left-to-right assignment evaluation order.
    [amount, now + this.cooldownMs, amount, now,
      this.scope, round, now, amount])
    return result.affectedRows === 1
  }

  async refund(round: number, bytes: number): Promise<void> {
    const amount = positiveBytes(bytes, 'shared pressure refund')
    await this.db.pool.query(`
      UPDATE parse_storage_pressure
      SET reclaimed_bytes = reclaimed_bytes - ?, updated_at_ms = ?
      WHERE scope = ? AND round = ? AND reclaimed_bytes >= ?`,
    [amount, Date.now(), this.scope, round, amount])
  }

  async state(): Promise<PressureRound | null> {
    const [rows] = await this.db.pool.query<RowDataPacket[]>(`
      SELECT round, target_bytes, reclaimed_bytes, expires_at_ms
      FROM parse_storage_pressure WHERE scope = ?`, [this.scope])
    const row = rows[0]
    if (!row) return null
    const expiresAt = safeNumber(row.expires_at_ms, 'expiry')
    const targetBytes = safeNumber(row.target_bytes, 'target')
    const reclaimedBytes = safeNumber(row.reclaimed_bytes, 'reclaimed')
    return { round: safeNumber(row.round, 'round'), targetBytes, reclaimedBytes,
      remainingBytes: Math.max(0, targetBytes - reclaimedBytes), expiresAt,
      expired: expiresAt <= Date.now() }
  }
}
