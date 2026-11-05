import { Worker } from 'node:worker_threads'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import type { WidthItem } from './metrics'
import type { PptxFontSummary, PptxLayoutInfo, PptxLayoutSlide, PptxSlideUnit } from './pptx-core'

export type { PptxFontSummary, PptxLayoutInfo, PptxLayoutSlide, PptxSlideUnit } from './pptx-core'

/** A parse job exceeded its budget; the worker was terminated. */
export class ParseTimeoutError extends Error {
  readonly code = 'parse_timeout'
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`pptx ${operation} timed out after ${timeoutMs}ms`)
    this.name = 'ParseTimeoutError'
  }
}

export interface PptxOpenInput {
  id: string
  fileId: string
  path: string
  width: number
  parserVersion: string
  baseUrl: string
  limits: ServerLimits
  mediaSecret?: string
  /** Kill and remove the session when the worker exits unexpectedly. */
  onDead?: () => void
  parseTimeoutMs: number
  unitTimeoutMs: number
  workerMemoryMb: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Main-thread handle for a PPTX session that lives in a worker thread.
 *
 * The parser and renderer never run on the HTTP event loop: a malformed or
 * huge deck can be killed by timeout/memory limits without taking the server
 * down. The worker is owned by exactly one session.
 */
export class PptxSession {
  model!: DocModel
  fonts!: PptxFontSummary[]
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
    readonly width: number,
    options: { onDead?: () => void; unitTimeoutMs: number },
  ) {
    this.worker = worker
    this.onDead = options.onDead
    this.unitTimeoutMs = options.unitTimeoutMs
    worker.on('message', this.handleMessage)
    worker.on('error', (error) => this.fail(error))
    worker.on('exit', (code) => {
      if (this.dead) return
      this.fail(new Error(`parse worker exited with code ${code}`))
    })
  }

  static async open(input: PptxOpenInput): Promise<PptxSession> {
    const { onDead, parseTimeoutMs, unitTimeoutMs, workerMemoryMb, ...workerInput } = input
    const worker = new Worker(new URL('./pptx-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: workerMemoryMb },
    })
    const session = new PptxSession(worker, input.id, input.fileId, input.width, {
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
      throw new Error('pptx: invalid unit cursor')
    }
    const end = Math.min(total, start + Math.max(1, Math.min(limit, 500)))
    const items: UnitSummary[] = []
    for (let index = start; index < end; index++) {
      items.push({ id: String(index), kind: 'slide', index, anchor: String(index) })
    }
    return { items, ...(end < total ? { next: String(end) } : {}) }
  }

  unit(unitId: string): Promise<PptxSlideUnit> {
    return this.call('unit', { unitId }, this.unitTimeoutMs)
  }

  fontBytes(fontId: string): Promise<Uint8Array | null> {
    return this.call('font', { fontId }, this.unitTimeoutMs)
  }

  /** Deck-level input for client-side layout. */
  layoutInfo(): Promise<PptxLayoutInfo> {
    return this.call('layoutInfo', {}, this.unitTimeoutMs)
  }

  /** Parsed slide model the viewer lays out itself. */
  layoutModel(unitId: string): Promise<PptxLayoutSlide> {
    return this.call('layoutModel', { unitId }, this.unitTimeoutMs)
  }

  /** Accept browser text widths; returns the remaining measurements. */
  acceptWidths(widths: Readonly<Record<string, number>>): Promise<WidthItem[]> {
    return this.call<{ measurements: WidthItem[] }>('widths', { widths }, this.unitTimeoutMs).then(
      (result) => result.measurements,
    )
  }

  close(): void {
    if (this.dead) return
    this.dead = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('parse session is closed'))
    }
    this.pending.clear()
    this.worker.postMessage({ id: ++this.nextId, op: 'close' })
    const timer = setTimeout(() => void this.worker.terminate(), 100)
    timer.unref?.()
  }

  private call<T>(op: string, input: unknown, timeoutMs: number): Promise<T> {
    if (this.dead) return Promise.reject(new Error('parse session is closed'))
    return new Promise<T>((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => {
        this.fail(new ParseTimeoutError(op, timeoutMs))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
      this.worker.postMessage({ id, op, input })
    })
  }

  private readonly handleMessage = (message: {
    id: number
    ok: boolean
    result?: unknown
    error?: string
    code?: string
  }): void => {
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else {
      const error = new Error(message.error || 'parse worker failed')
      if (message.code) (error as { code?: string }).code = message.code
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
    void this.worker.terminate()
    this.onDead?.()
  }
}
