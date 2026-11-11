import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DocModel } from '@genoffice/parse-contract'
import type { PptxFontSummary } from './pptx'
import type { MysqlDatabase } from './mysql'
import { normalizeLayoutPrefs, type LayoutPrefs } from './layout-prefs'

const HASH = /^[a-f0-9]{64}$/

/** New records reference the shared artifact; legacy v1 payload is read-only fallback. */
export type SessionFormat = 'pptx' | 'docx'

export interface SessionRecord {
  id: string
  fileId: string
  width: number
  parserVersion: string
  /** Artifact format; authoritative for reopening from the shared artifact. */
  format?: SessionFormat
  /** Catalog identity of the shared artifact; absent only on legacy rows. */
  artifactKey?: string
  /** Idle deadline mirrored into MySQL: lastUsed + session TTL. */
  expiresAt?: number
  /** Temporary reading position/layout preference (plan §4.1/§5). */
  layoutPrefs?: LayoutPrefs
  /** @deprecated Legacy copy: new records reference the artifact instead. */
  baseUrl?: string
  /** @deprecated Legacy copy: new records reference the artifact instead. */
  model?: DocModel
  /** @deprecated Legacy copy: new records reference the artifact instead. */
  fonts?: PptxFontSummary[]
  createdAt: number
  lastUsed: number
}

/**
 * Small JSON-backed session index. It intentionally stores only metadata:
 * the worker and its render trees are rebuilt lazily on the first request
 * after a restart.
 */
function recordFromRow(row: any): SessionRecord {
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    width: Number(row.width),
    parserVersion: String(row.parser_version),
    ...(typeof row.base_url === 'string' ? { baseUrl: row.base_url } : {}),
    ...(row.model !== null && row.model !== undefined
      ? { model: typeof row.model === 'string' ? JSON.parse(row.model) : row.model }
      : {}),
    ...(row.fonts !== null && row.fonts !== undefined
      ? { fonts: typeof row.fonts === 'string' ? JSON.parse(row.fonts) : row.fonts }
      : {}),
    ...(row.format === 'pptx' || row.format === 'docx' ? { format: row.format } : {}),
    ...(() => {
      const value = typeof row.layout_prefs === 'string'
        ? JSON.parse(row.layout_prefs) : row.layout_prefs
      try {
        const prefs = normalizeLayoutPrefs(value)
        return prefs ? { layoutPrefs: prefs } : {}
      } catch {
        return {}
      }
    })(),
    createdAt: Number(row.created_at),
    lastUsed: Number(row.last_used),
    ...(typeof row.artifact_key === 'string' && HASH.test(row.artifact_key)
      ? { artifactKey: row.artifact_key } : {}),
    ...(row.expires_at !== null && row.expires_at !== undefined &&
      Number.isSafeInteger(Number(row.expires_at))
      ? { expiresAt: Number(row.expires_at) } : {}),
  }
}

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
        `SELECT id, file_id, width, parser_version, base_url, model, fonts, created_at, last_used,
                artifact_key, expires_at, format, layout_prefs
         FROM parse_sessions WHERE last_used >= ?`,
        [cutoff],
      )
      for (const row of rows as any[]) {
        const record = recordFromRow(row)
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

  /**
   * Cross-instance attach (plan §5 ready ownership): read one durable ready
   * session that this process did not create. Read-only; callers decide whether
   * to cache it and must not mutate another builder's leases.
   */
  async load(id: string): Promise<SessionRecord | undefined> {
    if (!this.db) return this.records.get(id)
    const [rows] = await this.db.pool.query(
      `SELECT id, file_id, width, parser_version, base_url, model, fonts, created_at, last_used,
              artifact_key, expires_at, format, layout_prefs
       FROM parse_sessions WHERE id = ?`,
      [id],
    )
    const row = (rows as any[])[0]
    if (!row) return undefined
    const record = recordFromRow(row)
    return isRecord(record) ? record : undefined
  }

  async set(record: SessionRecord): Promise<void> {
    this.records.set(record.id, record)
    if (this.db) {
      await this.db.pool.query(
        `INSERT INTO parse_sessions
           (id, file_id, width, parser_version, base_url, model, fonts, created_at, last_used,
            artifact_key, expires_at, format, layout_prefs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           file_id=VALUES(file_id), width=VALUES(width), parser_version=VALUES(parser_version),
           base_url=VALUES(base_url), model=VALUES(model), fonts=VALUES(fonts),
           format=VALUES(format), last_used=VALUES(last_used),
           artifact_key=VALUES(artifact_key), expires_at=VALUES(expires_at),
           layout_prefs=VALUES(layout_prefs)`,
        [
          record.id,
          record.fileId,
          record.width,
          record.parserVersion,
          record.baseUrl ?? null,
          record.model === undefined ? null : JSON.stringify(record.model),
          record.fonts === undefined ? null : JSON.stringify(record.fonts),
          record.createdAt,
          record.lastUsed,
          record.artifactKey ?? null,
          record.expiresAt ?? null,
          record.format ?? null,
          record.layoutPrefs === undefined ? null : JSON.stringify(record.layoutPrefs),
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
    typeof record.createdAt === 'number' &&
    typeof record.lastUsed === 'number' &&
    (record.format === undefined || record.format === 'pptx' || record.format === 'docx') &&
    (record.baseUrl === undefined ||
      record.baseUrl === null ||
      typeof record.baseUrl === 'string') &&
    (record.artifactKey === undefined ||
      (typeof record.artifactKey === 'string' && HASH.test(record.artifactKey))) &&
    (record.expiresAt === undefined ||
      (typeof record.expiresAt === 'number' && Number.isSafeInteger(record.expiresAt))) &&
    (() => {
      try {
        normalizeLayoutPrefs(record.layoutPrefs)
        return true
      } catch {
        return false
      }
    })() &&
    // A record must carry either the artifact identity or the legacy payload;
    // new records always have the identity and no full model copy.
    (typeof record.artifactKey === 'string' ||
      (!!record.model && typeof record.model === 'object' && Array.isArray(record.fonts)))
  )
}
