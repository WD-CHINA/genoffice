import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { DocModel } from '@genoffice/parse-contract'
import type { PptxFontSummary } from './pptx'

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

  constructor(dataDir: string) {
    this.path = join(dataDir, 'sessions.json')
  }

  async init(ttlMs: number): Promise<void> {
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
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    if (!this.records.delete(id)) return
    await this.persist()
  }

  /** Wait for queued writes; call before shutting down or deleting the data dir. */
  async flush(): Promise<void> {
    await this.writeChain
  }

  private persist(): Promise<void> {
    const payload = JSON.stringify(this.values())
    this.writeChain = this.writeChain
      .then(async () => {
        const tmp = `${this.path}.tmp`
        await writeFile(tmp, payload)
        await rename(tmp, this.path)
      })
      .catch(() => undefined)
    return this.writeChain
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
