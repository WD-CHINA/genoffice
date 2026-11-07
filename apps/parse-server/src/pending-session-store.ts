import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { MysqlDatabase } from './mysql'

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
    (!record.error ||
      (Number.isSafeInteger(record.error.status) &&
        record.error.status >= 400 &&
        record.error.status <= 599 &&
        typeof record.error.code === 'string' &&
        typeof record.error.message === 'string'))
  )
}

/** Durable v2 waiters. This journal is single-instance; it is not a distributed job lease. */
export class PendingSessionStore {
  private records = new Map<string, PendingSession>()
  private tail = Promise.resolve()
  private readonly observedBuilding = new Set<string>()
  constructor(
    private readonly root: string,
    private readonly db?: MysqlDatabase,
  ) {}

  async init(ttlMs: number): Promise<void> {
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
  create(input: Omit<PendingSession, 'jobId'>): Promise<PendingSession> {
    return this.mutate(async () => {
      const shared = this.values().find(
        (item) => item.artifactKey === input.artifactKey && !item.error,
      )
      const record = { ...input, jobId: shared?.jobId ?? randomUUID() }
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
