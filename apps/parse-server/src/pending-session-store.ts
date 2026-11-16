import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { RowDataPacket } from 'mysql2/promise'
import type { MysqlDatabase } from './mysql'
import { normalizeLayoutPrefs, type LayoutPrefs } from './layout-prefs'

export interface PendingSession {
  id: string
  jobId: string
  artifactKey: string
  fileId: string
  format: 'pptx' | 'docx'
  width: number
  parserVersion: string
  parserFingerprint: string
  createdAt: number
  lastUsed: number
  /** Temporary reading position/layout preference (plan §4.1/§5). */
  layoutPrefs?: LayoutPrefs
  state?: 'queued' | 'building'
  error?: { status: number; code: string; message: string }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
function valid(record: PendingSession): boolean {
  return (
    !!record &&
    uuid.test(record.id) &&
    uuid.test(record.jobId) &&
    hash.test(record.fileId) &&
    hash.test(record.artifactKey) &&
    ['pptx', 'docx'].includes(record.format) &&
    Number.isSafeInteger(record.width) &&
    record.width >= 320 &&
    record.width <= 4096 &&
    typeof record.parserVersion === 'string' &&
    typeof record.parserFingerprint === 'string' &&
    Number.isSafeInteger(record.createdAt) &&
    record.createdAt >= 0 &&
    Number.isSafeInteger(record.lastUsed) &&
    record.lastUsed >= record.createdAt &&
    (() => {
      try {
        normalizeLayoutPrefs(record.layoutPrefs)
        return true
      } catch {
        return false
      }
    })() &&
    (!record.error ||
      (Number.isSafeInteger(record.error.status) &&
        record.error.status >= 400 &&
        record.error.status <= 599 &&
        typeof record.error.code === 'string' &&
        typeof record.error.message === 'string'))
  )
}

/** Durable async waiters. This journal is single-instance; it is not a distributed job lease. */
export class PendingSessionStore {
  private records = new Map<string, PendingSession>()
  private tail = Promise.resolve()
  private readonly observedBuilding = new Set<string>()
  /** Sessions created by another live instance; attach read-only, never take over. */
  private readonly remoteIds = new Set<string>()
  private ttlMs = 0
  constructor(
    private readonly root: string,
    private readonly db?: MysqlDatabase,
  ) {}

  async init(ttlMs: number): Promise<void> {
    this.ttlMs = ttlMs
    let records: unknown
    if (this.db) {
      await this.db.pool.query('DELETE FROM parse_pending_sessions WHERE last_used < ?', [
        Date.now() - ttlMs,
      ])
      const [rows] = await this.db.pool.query('SELECT record FROM parse_pending_sessions')
      records = (rows as Array<{ record: unknown }>).map((row) =>
        typeof row.record === 'string' ? JSON.parse(row.record) : row.record,
      )
    } else {
      await mkdir(this.root, { recursive: true })
      try {
        records = JSON.parse(await readFile(join(this.root, 'pending-sessions.json'), 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
    if (!Array.isArray(records)) throw new Error('invalid pending session journal')
    for (const record of records) {
      if (!valid(record) || this.records.has(record.id))
        throw new Error('invalid pending session record')
      if (record.lastUsed >= Date.now() - ttlMs)
        this.records.set(record.id, { ...record, state: 'queued' })
    }
    if (!this.db) await this.persist(this.records)
  }

  values(): PendingSession[] {
    return [...this.records.keys()].map((id) => this.get(id)!)
  }
  get(id: string): PendingSession | undefined {
    const record = this.records.get(id)
    return record && this.observedBuilding.has(id) ? { ...record, state: 'building' } : record
  }

  /**
   * Resolve a waiter created on another instance from the shared MySQL journal.
   * The row is cached locally but marked remote: this instance may serve its
   * status/preview, yet must not start a build or delete the builder's row.
   * File-index mode is single-instance, so it never loads.
   */
  async load(id: string): Promise<PendingSession | undefined> {
    if (!uuid.test(id)) return undefined
    const local = this.records.get(id)
    if (local) return this.get(id)
    if (!this.db) return undefined
    let rows: RowDataPacket[]
    try {
      const [result] = await this.db.pool.query<RowDataPacket[]>(
        'SELECT record, last_used FROM parse_pending_sessions WHERE id = ?',
        [id],
      )
      rows = result
    } catch {
      return undefined
    }
    const row = rows[0]
    if (!row) return undefined
    let parsed: unknown
    try {
      parsed = typeof row.record === 'string' ? JSON.parse(row.record) : row.record
    } catch {
      return undefined
    }
    if (!valid(parsed as PendingSession)) return undefined
    const record = parsed as PendingSession
    if (this.ttlMs > 0 && record.lastUsed < Date.now() - this.ttlMs) {
      // Expired remote row: remove it instead of serving a ghost session.
      await this.db.pool
        .query('DELETE FROM parse_pending_sessions WHERE id = ?', [id])
        .catch(() => undefined)
      return undefined
    }
    this.remoteIds.add(id)
    this.records.set(id, { ...record, state: 'queued' })
    return this.get(id)
  }

  /** Whether the durable waiter row still exists (remote views cache it locally). */
  async sharedExists(id: string): Promise<boolean> {
    if (!this.db) return this.records.has(id)
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT 1 FROM parse_pending_sessions WHERE id = ? LIMIT 1',
      [id],
    )
    return rows.length > 0
  }

  /** True when the waiter belongs to another live instance (attach read-only). */
  isRemote(id: string): boolean {
    return this.remoteIds.has(id)
  }

  /** Drop a locally cached remote waiter without touching the shared row. */
  forget(id: string): void {
    this.records.delete(id)
    this.observedBuilding.delete(id)
    this.remoteIds.delete(id)
  }
  /**
   * Durable reader demand for last-waiter cancellation (plan §6.2). Each
   * instance registers one reader per pending session it is serving; a short TTL
   * keeps crashed readers from pinning a build forever.
   */
  async registerReader(id: string, readerId: string, ttlMs = 120_000): Promise<void> {
    if (!this.db) return
    const now = Date.now()
    await this.db.pool.query(
      `INSERT INTO parse_pending_readers (session_id, reader_id, expires_at)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE expires_at=VALUES(expires_at)`,
      [id, readerId, now + ttlMs],
    )
    // Opportunistic cleanup keeps the table bounded without a separate timer.
    await this.db.pool
      .query('DELETE FROM parse_pending_readers WHERE expires_at < ?', [now])
      .catch(() => undefined)
  }

  /** Remove one reader and return how many active readers remain. */
  async removeReader(id: string, readerId: string): Promise<number> {
    if (!this.db) return this.records.has(id) ? 0 : 0
    await this.db.pool.query(
      'DELETE FROM parse_pending_readers WHERE session_id = ? AND reader_id = ?',
      [id, readerId],
    )
    return this.readerCount(id)
  }

  async readerCount(id: string): Promise<number> {
    if (!this.db) return this.records.has(id) ? 1 : 0
    const [rows] = await this.db.pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS n FROM parse_pending_readers WHERE session_id = ? AND expires_at > ?',
      [id, Date.now()],
    )
    return Number((rows[0] as { n?: unknown })?.n ?? 0)
  }

  /**
   * Persist a reading preference for a locally-owned waiter. Remote waiters are
   * read-only here: the building instance owns their journal row.
   */
  setLayoutPrefs(id: string, layoutPrefs: LayoutPrefs | undefined): Promise<boolean> {
    return this.mutate(async () => {
      if (this.remoteIds.has(id)) return false
      const record = this.records.get(id)
      if (!record) return false
      const next = { ...record, ...(layoutPrefs ? { layoutPrefs } : {}) }
      if (!layoutPrefs) delete next.layoutPrefs
      await this.put(next)
      return true
    })
  }

  observeBuilding(id: string): void {
    if (this.records.has(id)) this.observedBuilding.add(id)
  }
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  private async persist(records: Map<string, PendingSession>): Promise<void> {
    const temp = join(this.root, `pending-sessions.${randomUUID()}.tmp`)
    const file = await open(temp, 'wx')
    try {
      await file.writeFile(JSON.stringify([...records.values()]))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, join(this.root, 'pending-sessions.json'))
    this.records = records
    const directory = await open(this.root, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  private async put(record: PendingSession): Promise<void> {
    if (!valid(record)) throw new Error('invalid pending session record')
    if (this.db) {
      await this.db.pool.query(
        `INSERT INTO parse_pending_sessions (id, file_id, last_used, record) VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE last_used=VALUES(last_used), record=VALUES(record)`,
        [record.id, record.fileId, record.lastUsed, JSON.stringify(record)],
      )
      this.records.set(record.id, record)
    } else {
      const next = new Map(this.records)
      next.set(record.id, record)
      await this.persist(next)
    }
  }
  /**
   * Create a durable waiter. The job id prefers the catalog's in-flight build
   * lease (same artifact, another instance) so `GET /v1/sessions/:id` and the
   * shared progress projection agree; otherwise an existing local waiter for the
   * same artifact is reused before falling back to a fresh id.
   */
  create(input: Omit<PendingSession, 'jobId'>, preferredJobId?: string): Promise<PendingSession> {
    return this.mutate(async () => {
      const shared = this.values().find(
        (item) => item.artifactKey === input.artifactKey && !item.error,
      )
      const candidate = preferredJobId ?? shared?.jobId
      const record = {
        ...input,
        jobId: candidate && uuid.test(candidate) ? candidate : randomUUID(),
      }
      await this.put(record)
      return record
    })
  }
  touch(id: string): Promise<void> {
    return this.mutate(async () => {
      const current = this.records.get(id)
      if (current && Date.now() - current.lastUsed >= 30_000)
        await this.put({ ...current, lastUsed: Date.now() })
    })
  }
  fail(id: string, error: PendingSession['error']): Promise<void> {
    return this.mutate(async () => {
      const current = this.records.get(id)
      if (!current) return
      const record = { ...current, error, lastUsed: Date.now() }
      try {
        await this.put(record)
      } catch (failure) {
        // A failed status write cannot make the active request look indefinitely queued.
        this.records.set(id, record)
        throw failure
      }
    })
  }
  remove(id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.records.has(id)) return
      this.observedBuilding.delete(id)
      this.remoteIds.delete(id)
      if (this.db) {
        await this.db.pool.query('DELETE FROM parse_pending_sessions WHERE id = ?', [id])
        this.records.delete(id)
      } else {
        const next = new Map(this.records)
        next.delete(id)
        await this.persist(next)
      }
    })
  }
  async flush(): Promise<void> {
    await this.tail
  }
}
