import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DocModel } from '@genoffice/parse-contract'
import type { PptxFontSummary } from './pptx'
import type { MysqlDatabase } from './mysql'

/** Everything needed to reopen a PPTX session after a process restart. */
export interface SessionRecord {
  id: string
  fileId: string
  width: number
  parserVersion: string
  baseUrl: string
  model: DocModel
  fonts: PptxFontSummary[]
  createdAt: number
  lastUsed: number
}

/**
 * Small JSON-backed session index. It intentionally stores only metadata:
 * the worker and its render trees are rebuilt lazily on the first request
 * after a restart.
 */
export class SessionStore {
  private readonly path: string
  private readonly records = new Map<string, SessionRecord>()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    dataDir: string,
    private readonly db?: MysqlDatabase,
  ) {
    this.path = join(dataDir, 'sessions.json')
  }

  async init(ttlMs: number): Promise<void> {
    if (this.db) {
      const cutoff = Date.now() - ttlMs
      const [rows] = await this.db.pool.query(
        `SELECT id, file_id, width, parser_version, base_url, model, fonts, created_at, last_used
         FROM parse_sessions WHERE last_used >= ?`,
        [cutoff],
      )
      for (const row of rows as any[]) {
        const record: SessionRecord = {
          id: String(row.id),
          fileId: String(row.file_id),
          width: Number(row.width),
          parserVersion: String(row.parser_version),
          baseUrl: String(row.base_url),
          model: typeof row.model === 'string' ? JSON.parse(row.model) : row.model,
          fonts: typeof row.fonts === 'string' ? JSON.parse(row.fonts) : row.fonts,
          createdAt: Number(row.created_at),
          lastUsed: Number(row.last_used),
        }
        if (isRecord(record)) this.records.set(record.id, record)
      }
      return
    }
    await mkdir(dirname(this.path), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!Array.isArray(parsed)) return
      const cutoff = Date.now() - ttlMs
      for (const item of parsed) {
        if (!isRecord(item) || item.lastUsed < cutoff) continue
        this.records.set(item.id, item)
      }
    } catch {
      // Missing or corrupt index: start empty; the content store is still intact.
    }
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id)
  }

  values(): SessionRecord[] {
    return [...this.records.values()]
  }

  async set(record: SessionRecord): Promise<void> {
    this.records.set(record.id, record)
    if (this.db) {
      await this.db.pool.query(
        `INSERT INTO parse_sessions
           (id, file_id, width, parser_version, base_url, model, fonts, created_at, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           file_id=VALUES(file_id), width=VALUES(width), parser_version=VALUES(parser_version),
           base_url=VALUES(base_url), model=VALUES(model), fonts=VALUES(fonts), last_used=VALUES(last_used)`,
        [
          record.id,
          record.fileId,
          record.width,
          record.parserVersion,
          record.baseUrl,
          JSON.stringify(record.model),
          JSON.stringify(record.fonts),
          record.createdAt,
          record.lastUsed,
        ],
      )
      return
    }
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    if (!this.records.delete(id)) return
    if (this.db) {
      await this.db.pool.query('DELETE FROM parse_sessions WHERE id = ?', [id])
      return
    }
    await this.persist()
  }

  /** Wait for queued writes; call before shutting down or deleting the data dir. */
  async flush(): Promise<void> {
    await this.writeChain
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify(this.values())
    const task = this.writeChain.then(async () => {
      const tmp = `${this.path}.tmp`
      const file = await open(tmp, 'w')
      try {
        await file.writeFile(payload)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(tmp, this.path)
      const directory = await open(dirname(this.path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    })
    this.writeChain = task.catch(() => undefined)
    return task
  }
}

function isRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<SessionRecord>
  return (
    typeof record.id === 'string' &&
    typeof record.fileId === 'string' &&
    typeof record.width === 'number' &&
    typeof record.parserVersion === 'string' &&
    typeof record.baseUrl === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.lastUsed === 'number' &&
    !!record.model &&
    typeof record.model === 'object' &&
    Array.isArray(record.fonts)
  )
}
