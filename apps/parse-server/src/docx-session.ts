import { Worker } from 'node:worker_threads'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import type { PptxFontSummary } from './pptx-core'

export interface DocxOpenInput {
  id: string
  fileId: string
  path: string
  parserVersion: string
  baseUrl: string
  limits: ServerLimits
  parseTimeoutMs: number
  unitTimeoutMs: number
  workerMemoryMb: number
  /** Directory for persisted chunk JSON files. */
  chunksDir: string
  onDead?: () => void
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class DocxTimeoutError extends Error {
  readonly code = 'parse_timeout'
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`docx ${operation} timed out after ${timeoutMs}ms`)
    this.name = 'DocxTimeoutError'
  }
}

/** Main-thread handle for a DOCX session whose parse/chunks live in a worker. */
export class DocxSession {
  model!: DocModel
  fonts: PptxFontSummary[] = []
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private readonly onDead?: () => void
  private readonly unitTimeoutMs: number
  private nextId = 0
  private dead = false
  private lastUsed = Date.now()

  private constructor(
    worker: Worker,
    readonly id: string,
    readonly fileId: string,
    options: { onDead?: () => void; unitTimeoutMs: number },
  ) {
    this.worker = worker
    this.onDead = options.onDead
    this.unitTimeoutMs = options.unitTimeoutMs
    worker.on('message', this.handleMessage)
    worker.on('error', (error) => this.fail(error))
    worker.on('exit', (code) => {
      if (this.dead) return
      this.fail(new Error(`docx worker exited with code ${code}`))
    })
  }

  static async open(input: DocxOpenInput): Promise<DocxSession> {
    const { onDead, parseTimeoutMs, unitTimeoutMs, workerMemoryMb, ...workerInput } = input
    const worker = new Worker(new URL('./docx-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: workerMemoryMb },
    })
    const session = new DocxSession(worker, input.id, input.fileId, {
      onDead,
      unitTimeoutMs,
    })
    try {
      const opened = await session.call<{ model: DocModel; fonts: PptxFontSummary[] }>(
        'open',
        workerInput,
        parseTimeoutMs,
      )
      session.model = opened.model
      session.fonts = opened.fonts
      return session
    } catch (error) {
      session.close()
      throw error
    }
  }

  touch(): void {
    this.lastUsed = Date.now()
  }

  idleSince(): number {
    return this.lastUsed
  }

  units(cursor?: string, limit = 100): { items: UnitSummary[]; next?: string } {
    const total = this.model.unitCount ?? 0
    const start = cursor ? Number.parseInt(cursor, 10) : 0
    if (!Number.isInteger(start) || start < 0 || start > total) {
      throw new Error('docx: invalid unit cursor')
    }
    const end = Math.min(total, start + Math.max(1, Math.min(limit, 500)))
    const items: UnitSummary[] = []
    for (let index = start; index < end; index++) {
      items.push({ id: String(index), kind: 'block-chunk', index, anchor: String(index) })
    }
    return { items, ...(end < total ? { next: String(end) } : {}) }
  }

  async unit(id: string): Promise<unknown> {
    this.touch()
    return this.call('unit', { id }, this.unitTimeoutMs)
  }

  async fontBytes(id: string): Promise<Uint8Array | null> {
    const bytes = await this.call<Uint8Array | null>('font', { id }, this.unitTimeoutMs)
    return bytes ?? null
  }

  async acceptWidths(_widths: Record<string, number>): Promise<unknown[]> {
    return []
  }

  close(): void {
    if (this.dead) return
    this.dead = true
    try {
      this.worker.postMessage({ id: -1, method: 'close' })
    } catch {
      /* worker already gone */
    }
    void this.worker.terminate()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('docx session closed'))
    }
    this.pending.clear()
  }

  private call<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.dead) return Promise.reject(new Error('docx session is closed'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new DocxTimeoutError(method, timeoutMs))
        this.close()
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        this.worker.postMessage({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private readonly handleMessage = (message: {
    id: number
    ok: boolean
    result?: unknown
    error?: { message?: string; code?: string }
  }): void => {
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) {
      pending.resolve(message.result)
    } else {
      const error = new Error(message.error?.message ?? 'docx worker failed') as Error & {
        code?: string
      }
      if (message.error?.code) error.code = message.error.code
      pending.reject(error)
    }
  }

  private fail(error: Error): void {
    if (this.dead) return
    this.dead = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.onDead?.()
  }
}
