import { readingLayoutPrefs } from './reading-position'
import {
  openServerSession, updateSessionLayoutPrefs, type ServerSessionTarget,
} from './server-session'
import { DocxChunkCache } from './docx-chunk-cache'
import { DocxReadQueue } from './docx-read-queue'
import { needsResourceRefresh, originOf } from './signed-url'
import type { DocModel } from '@genoffice/parse-contract'

export interface DocxOpened {
  sessionId: string
  model?: Pick<DocModel, 'page' | 'docx'>
  fonts?: Array<{ id: string; family: string; bold: boolean; italic: boolean }>
}
interface Listing {
  items: Array<{ id: string }>
  next?: string
}
export interface DocxChunk {
  blocks: any[]
  units: Array<{ id: string; blocks: any[] }>
  next?: string
  hasMore: boolean
}
class SessionExpired extends Error {
  constructor(readonly sessionId?: string) {
    super('DOCX 会话已失效，请重试')
  }
}

/** Owns one document generation; closing fences even fetch implementations that ignore abort. */
export class DocxRemoteSession {
  private readonly controller = new AbortController()
  private readonly base: string
  private readonly baseOrigin: string | undefined
  private readonly headers: Record<string, string>
  private id?: string
  private opening?: Promise<DocxOpened>
  private loading?: Promise<DocxChunk>
  private timer?: ReturnType<typeof setInterval>
  private readonly committed = new Set<string>()
  private readonly chunks = new DocxChunkCache<{ blocks: any[] }>()
  private readonly reads = new DocxReadQueue()
  private lastPrefAt = 0
  private readonly unitRequests = new Map<string, {
    promise: Promise<{ blocks: any[] }>; controller: AbortController
  }>()

  constructor(
    private readonly target: Omit<ServerSessionTarget, 'signal'>,
    private readonly onOpened: (opened: DocxOpened, signal: AbortSignal) => Promise<void>,
  ) {
    this.base = target.server.replace(/\/+$/, '')
    this.baseOrigin = originOf(this.base)
    this.headers = target.token ? { Authorization: `Bearer ${target.token}` } : {}
  }

  private check(): void {
    if (this.controller.signal.aborted) throw new DOMException('Document closed', 'AbortError')
  }

  get signal(): AbortSignal { return this.controller.signal }

  /** Incremental reading-position update on the heartbeat channel (throttled). */
  setLayoutPrefs(layoutPrefs: unknown): void {
    const id = this.id
    if (!id) return
    const now = Date.now()
    if (now - this.lastPrefAt < 750) return
    this.lastPrefAt = now
    void updateSessionLayoutPrefs(this.base, id, layoutPrefs, this.target.token)
      .catch(() => undefined)
  }

  private remove(id: string): void {
    void fetch(`${this.base}/v1/sessions/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.headers,
      keepalive: true,
    }).catch(() => undefined)
  }

  async open(): Promise<DocxOpened> {
    this.check()
    if (this.opening) return this.opening
    const job = Promise.resolve().then(async () => {
      const layoutPrefs = readingLayoutPrefs(this.target.fileId)
      const opened = await openServerSession<DocxOpened>({
        ...this.target,
        ...(layoutPrefs ? { layoutPrefs } : {}),
        signal: this.controller.signal,
      })
      if (this.controller.signal.aborted) {
        this.remove(opened.sessionId)
        this.check()
      }
      this.id = opened.sessionId
      // Resource URLs belong to the new session; never reuse an old signed URL.
      this.chunks.clear()
      try {
        await this.onOpened(opened, this.controller.signal)
        this.check()
      } catch (error) {
        this.remove(opened.sessionId)
        if (this.id === opened.sessionId) this.id = undefined
        throw error
      }
      if (!this.timer)
        this.timer = setInterval(() => {
          const id = this.id
          if (!id) return
          void fetch(`${this.base}/v1/sessions/${encodeURIComponent(id)}`, {
            headers: this.headers,
            signal: this.controller.signal,
          })
            .then((response) => {
              if (
                !this.controller.signal.aborted &&
                this.id === id &&
                [404, 410].includes(response.status)
              )
                this.id = undefined
            })
            .catch(() => undefined)
        }, 60_000)
      return opened
    })
    this.opening = job
    try {
      return await job
    } finally {
      if (this.opening === job) this.opening = undefined
    }
  }

  private json(path: string, signal = this.controller.signal): Promise<any> {
    return this.reads.run(signal, async () => {
      const requestedSession = this.id
      if (!requestedSession) throw new SessionExpired()
      const response = await fetch(
        `${this.base}/v1/sessions/${encodeURIComponent(requestedSession!)}/${path}`,
        {
          headers: this.headers,
          signal,
        },
      )
      this.check()
      signal.throwIfAborted()
      if (!response.ok) {
        await response.body?.cancel()
        if ([404, 410].includes(response.status)) throw new SessionExpired(requestedSession)
        throw new Error(`读取 DOCX 失败（HTTP ${response.status}）`)
      }
      const body = await response.json()
      this.check()
      signal.throwIfAborted()
      if (this.id !== requestedSession) throw new SessionExpired(requestedSession)
      return body
    })
  }

  /** One UI window owns random reads; cancelling it never cancels source parsing or append. */
  retainUnits(ids: readonly string[]): void {
    const retained = new Set(ids)
    for (const [id, request] of this.unitRequests) {
      if (retained.has(id)) continue
      this.unitRequests.delete(id)
      request.controller.abort(new DOMException('Page left viewport', 'AbortError'))
    }
  }

  /** Random access for revisiting an evicted unit; independent of the append cursor. */
  unit(id: string): Promise<{ blocks: any[] }> {
    this.check()
    const existing = this.unitRequests.get(id)
    if (existing) return existing.promise
    const controller = new AbortController()
    const signal = AbortSignal.any([this.controller.signal, controller.signal])
    const job = Promise.resolve().then(async () => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted()
        if (!this.id) await this.open()
        signal.throwIfAborted()
        const cached = this.chunks.get(id)
        // A cached chunk may carry signed URLs that expired (or point at a
        // previous deployment origin): refresh the description from the server.
        if (cached && !needsResourceRefresh(cached, { baseOrigin: this.baseOrigin }))
          return cached
        try {
          const unit = await this.json(`units/${encodeURIComponent(id)}`, signal)
          if (!unit || !Array.isArray(unit.blocks)) throw new Error('DOCX chunk 格式无效')
          this.chunks.set(id, unit)
          return unit as { blocks: any[] }
        } catch (error) {
          if (!(error instanceof SessionExpired) || attempt >= 1) throw error
          if (this.id === error.sessionId) this.id = undefined
        }
      }
    })
    const request = { promise: job, controller }
    this.unitRequests.set(id, request)
    void job.finally(() => {
      if (this.unitRequests.get(id) === request) this.unitRequests.delete(id)
    }).catch(() => undefined)
    return job
  }

  load(next?: string, prepare?: (units: DocxChunk['units']) => Promise<void>): Promise<DocxChunk> {
    this.check()
    if (this.loading) return this.loading
    const job = Promise.resolve().then(async () => {
      for (let attempt = 0; ; attempt++) {
        if (!this.id) await this.open()
        try {
          const query = new URLSearchParams({ limit: '1' })
          if (next) query.set('cursor', next)
          const listing = (await this.json(`units?${query}`)) as Listing
          const blocks: any[] = []
          const units: DocxChunk['units'] = []
          const ids: string[] = []
          for (const item of listing.items) {
            if (this.committed.has(item.id)) continue
            let unit = this.chunks.get(item.id)
            if (unit && needsResourceRefresh(unit, { baseOrigin: this.baseOrigin }))
              unit = undefined
            if (!unit) unit = await this.json(`units/${encodeURIComponent(item.id)}`)
            if (!unit || !Array.isArray(unit.blocks)) throw new Error('DOCX chunk 格式无效')
            this.chunks.set(item.id, unit)
            blocks.push(...unit.blocks)
            units.push({ id: item.id, blocks: unit.blocks })
            ids.push(item.id)
          }
          this.check()
          await prepare?.(units)
          this.check()
          for (const id of ids) this.committed.add(id)
          return { blocks, units, next: listing.next, hasMore: !!listing.next }
        } catch (error) {
          if (!(error instanceof SessionExpired) || attempt >= 1) throw error
          if (this.id === error.sessionId) this.id = undefined
        }
      }
    })
    this.loading = job
    void job
      .finally(() => {
        if (this.loading === job) this.loading = undefined
      })
      .catch(() => undefined)
    return job
  }

  close(): void {
    if (this.controller.signal.aborted) return
    this.controller.abort()
    clearInterval(this.timer)
    if (this.id) this.remove(this.id)
    this.id = undefined
    this.chunks.clear()
    this.unitRequests.clear()
  }
}
