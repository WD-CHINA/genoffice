import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { MysqlDatabase } from './mysql'

export interface LibraryEntry {
  id: string
  fileId: string
  displayName: string
  /** Plan §5: instance-level until reliable multi-user identity is wired in. */
  libraryScope: 'instance'
  retention: 'saved'
  createdAt: number
  updatedAt: number
  /** Soft-delete tombstone; only purged after the retention window. */
  deletedAt?: number
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const HASH = /^[a-f0-9]{64}$/
/** Torn-down history rows stay for audit/backup reconciliation, then disappear. */
const PURGE_DELETED_AFTER_MS = 30 * 24 * 60 * 60_000
function valid(value: LibraryEntry): boolean {
  return (
    !!value &&
    UUID.test(value.id) &&
    HASH.test(value.fileId) &&
    value.retention === 'saved' &&
    (value.libraryScope === undefined || value.libraryScope === 'instance') &&
    (value.deletedAt === undefined ||
      (Number.isSafeInteger(value.deletedAt) && value.deletedAt >= 0)) &&
    typeof value.displayName === 'string' &&
    value.displayName.length > 0 &&
    value.displayName.length <= 255 &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    Number.isSafeInteger(value.updatedAt) &&
    value.updatedAt >= value.createdAt
  )
}
function rowEntry(row: any): LibraryEntry {
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    displayName: String(row.display_name),
    libraryScope: 'instance',
    retention: 'saved',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.deleted_at !== null && row.deleted_at !== undefined
      ? { deletedAt: Number(row.deleted_at) }
      : {}),
  }
}

/** Instance-wide saved history. Never infer an owner from an untrusted request field. */
export class LibraryStore {
  private records = new Map<string, LibraryEntry>()
  private writeTail = Promise.resolve()
  constructor(
    private readonly root: string,
    private readonly db?: MysqlDatabase,
  ) {}

  async init(): Promise<void> {
    if (this.db) {
      await this.db.pool.query(
        'DELETE FROM library_entries WHERE deleted_at IS NOT NULL AND deleted_at < ?',
        [Date.now() - PURGE_DELETED_AFTER_MS],
      )
      return
    }
    await mkdir(this.root, { recursive: true })
    let bytes: string
    try {
      bytes = await readFile(join(this.root, 'library.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed: unknown = JSON.parse(bytes)
    if (!Array.isArray(parsed))
      throw new Error('invalid library index; refusing unsafe retention recovery')
    const files = new Set<string>()
    const cutoff = Date.now() - PURGE_DELETED_AFTER_MS
    for (const raw of parsed) {
      const entry = { ...(raw as LibraryEntry), libraryScope: 'instance' as const }
      if (!valid(entry) || this.records.has(entry.id) || files.has(entry.fileId))
        throw new Error('invalid library entry; refusing unsafe retention recovery')
      if (entry.deletedAt !== undefined && entry.deletedAt < cutoff) continue
      this.records.set(entry.id, entry)
      if (entry.deletedAt === undefined) files.add(entry.fileId)
    }
  }

  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    const task = this.writeTail.then(work)
    this.writeTail = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async persist(records: Map<string, LibraryEntry>): Promise<void> {
    const temporary = join(this.root, `library.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(JSON.stringify([...records.values()]))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, join(this.root, 'library.json'))
    this.records = records
    const directory = await open(this.root, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }

  async values(): Promise<LibraryEntry[]> {
    if (!this.db)
      return [...this.records.values()].filter((entry) => entry.deletedAt === undefined)
    const [rows] = await this.db.pool.query(
      'SELECT id, file_id, display_name, created_at, updated_at, deleted_at FROM library_entries WHERE deleted_at IS NULL',
    )
    const entries = (rows as any[]).map(rowEntry)
    if (!entries.every(valid)) throw new Error('invalid library database row')
    return entries
  }

  async page(
    limit: number,
    after?: { createdAt: number; id: string },
  ): Promise<{ items: LibraryEntry[]; hasMore: boolean }> {
    let entries: LibraryEntry[]
    if (this.db) {
      const where = after
        ? 'WHERE deleted_at IS NULL AND (created_at < ? OR (created_at = ? AND id > ?))'
        : 'WHERE deleted_at IS NULL'
      const parameters = after
        ? [after.createdAt, after.createdAt, after.id, limit + 1]
        : [limit + 1]
      const [rows] = await this.db.pool.query(
        `SELECT id, file_id, display_name, created_at, updated_at, deleted_at
        FROM library_entries ${where} ORDER BY created_at DESC, id ASC LIMIT ?`,
        parameters,
      )
      entries = (rows as any[]).map(rowEntry)
      if (!entries.every(valid)) throw new Error('invalid library database row')
    } else {
      entries = [...this.records.values()]
        .filter((entry) => entry.deletedAt === undefined)
        .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
        .filter(
          (entry) =>
            !after ||
            entry.createdAt < after.createdAt ||
            (entry.createdAt === after.createdAt && entry.id > after.id),
        )
    }
    return { items: entries.slice(0, limit), hasMore: entries.length > limit }
  }

  async hasFile(fileId: string): Promise<boolean> {
    if (!this.db)
      return [...this.records.values()].some(
        (entry) => entry.fileId === fileId && entry.deletedAt === undefined,
      )
    const [rows] = await this.db.pool.query(
      'SELECT id FROM library_entries WHERE file_id = ? AND deleted_at IS NULL LIMIT 1',
      [fileId],
    )
    return (rows as unknown[]).length > 0
  }

  async save(fileId: string, displayName: string): Promise<LibraryEntry> {
    const now = Date.now()
    const entry: LibraryEntry = {
      id: randomUUID(),
      fileId,
      displayName,
      libraryScope: 'instance',
      retention: 'saved',
      createdAt: now,
      updatedAt: now,
    }
    if (!valid(entry)) throw new Error('invalid library entry')
    return this.mutate(async () => {
      if (this.db) {
        await this.db.pool.query(
          `INSERT INTO library_entries
             (id, file_id, display_name, library_scope, retention, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, 'instance', 'saved', ?, ?, NULL)
           ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),
             library_scope=VALUES(library_scope), retention=VALUES(retention),
             deleted_at=NULL, updated_at=GREATEST(updated_at, VALUES(updated_at))`,
          [entry.id, fileId, displayName, now, now],
        )
        const [rows] = await this.db.pool.query(
          'SELECT id, file_id, display_name, created_at, updated_at, deleted_at FROM library_entries WHERE file_id = ?',
          [fileId],
        )
        const saved = rowEntry((rows as any[])[0])
        if (!valid(saved)) throw new Error('invalid saved library entry')
        return saved
      }
      const existing = [...this.records.values()].find((item) => item.fileId === fileId)
      const saved = existing
        ? { ...existing, displayName, deletedAt: undefined, updatedAt: Math.max(existing.updatedAt, now) }
        : entry
      const next = new Map(this.records)
      next.set(saved.id, saved)
      await this.persist(next)
      return saved
    })
  }

  async remove(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false
    return this.mutate(async () => {
      if (this.db) {
        // Soft delete: keep the row for audit/reconciliation, but it no longer
        // protects the source file from GC or appears in listings.
        const [result] = await this.db.pool.query(
          `UPDATE library_entries SET deleted_at = ?, file_id = NULL
           WHERE id = ? AND deleted_at IS NULL`,
          [Date.now(), id],
        )
        return (result as { affectedRows: number }).affectedRows > 0
      }
      const current = this.records.get(id)
      if (!current || current.deletedAt !== undefined) return false
      const next = new Map(this.records)
      next.set(id, { ...current, deletedAt: Date.now() })
      await this.persist(next)
      return true
    })
  }

  async flush(): Promise<void> {
    await this.writeTail
  }
}
