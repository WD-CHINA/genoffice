import { featureEnabled, fetchCapabilities } from './capabilities'

export type OpeningState = 'queued' | 'building' | 'previewable'
/** First-frame capability reported while an async job is still building. */
export interface PreviewNotice {
  sessionId: string
  /** Endpoint actually in use; Blocking fallbacks never report a preview. */
  endpoint: string
  unitsProduced: number
  unitCount: number
  availableUnits: { from: number; to: number }
}
export interface ServerSessionTarget {
  server: string
  fileId: string
  token?: string
  width?: number
  signal?: AbortSignal
  onState?: (state: OpeningState) => void
  /** Fires once when the server first reports committed preview units. */
  onPreview?: (preview: PreviewNotice) => void
  /** Tests/offline embeddings: skip the best-effort capabilities probe. */
  skipCapabilities?: boolean
  /** Reading position handed to the session contract (plan §4.1). */
  layoutPrefs?: unknown
}
interface Status {
  sessionId: string
  state?: 'ready' | OpeningState | 'failed'
  pollAfterMs?: number
  error?: { message?: string; code?: string }
  previewable?: boolean
  unitCount?: number
  progress?: { unitsProduced: number; unitCount: number; percent: number }
  availableUnits?: { from: number; to: number }
}
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Document opening cancelled', 'AbortError')
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    aborted(signal)
    const stop = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(new DOMException('Document opening cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    signal?.addEventListener('abort', stop, { once: true })
  })
}
async function responseError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { message?: string; code?: string }
    return new Error(body.message || body.code || `HTTP ${response.status}`)
  } catch {
    return new Error(`HTTP ${response.status}`)
  }
}

/** Async readiness with synchronous fallback for older servers and Android's local replay server. */
/** Incremental reading-position update on the heartbeat channel (plan §4.1). */
export async function updateSessionLayoutPrefs(
  server: string,
  sessionId: string,
  layoutPrefs: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `${server.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/heartbeat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ layoutPrefs }),
      signal,
    },
  )
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
}

export async function openServerSession<T extends { sessionId: string }>(
  target: ServerSessionTarget,
): Promise<T> {
  const base = target.server.replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (target.token) headers.Authorization = `Bearer ${target.token}`
  const capabilities = target.skipCapabilities
    ? undefined
    : await fetchCapabilities({ baseUrl: base, signal: target.signal })
  const allowPreview = featureEnabled(capabilities, 'incrementalPreview') !== false
  const endpoint = '/v1/sessions'
  let respondAsync = featureEnabled(capabilities, 'asyncSessions') !== false
  let id: string | undefined
  try {
    aborted(target.signal)
    const init: RequestInit = {
      method: 'POST',
      headers: { ...headers, ...(respondAsync ? { Prefer: 'respond-async' } : {}) },
      body: JSON.stringify({
        fileId: target.fileId,
        ...(target.width !== undefined ? { width: target.width } : {}),
        ...(target.layoutPrefs !== undefined ? { layoutPrefs: target.layoutPrefs } : {}),
      }),
      signal: target.signal,
    }
    let response = await fetch(`${base}${endpoint}`, init)
    if (respondAsync && (response.status === 404 || response.status === 405)) {
      respondAsync = false
      response = await fetch(`${base}${endpoint}`, { ...init, headers })
    }
    if (!response.ok) throw await responseError(response)
    let body = (await response.json()) as Status & T
    id = body.sessionId
    if (!id || typeof id !== 'string') throw new Error('解析服务未返回有效会话')
    let previewNotified = false
    for (;;) {
      aborted(target.signal)
      if (body.state === 'failed')
        throw new Error(body.error?.message || body.error?.code || '文档解析失败')
      if (body.state === 'ready' || (!body.state && response.status !== 202)) return body
      if (body.state !== 'queued' && body.state !== 'building')
        throw new Error('解析服务返回了未知会话状态')
      // `previewable` describes a building job, not a new terminal state: keep
      // polling until the full manifest makes the session ready.
      target.onState?.(body.previewable && allowPreview ? 'previewable' : body.state)
      if (body.previewable && allowPreview && !previewNotified && respondAsync) {
        previewNotified = true
        target.onPreview?.({
          sessionId: id,
          endpoint,
          unitsProduced: body.progress?.unitsProduced ?? 0,
          unitCount: body.progress?.unitCount ?? body.unitCount ?? 0,
          availableUnits: body.availableUnits ?? { from: 0, to: 0 },
        })
      }
      const delay = Math.min(
        5000,
        Math.max(100, Number.isFinite(body.pollAfterMs) ? body.pollAfterMs! : 500),
      )
      await wait(delay, target.signal)
      response = await fetch(`${base}${endpoint}/${encodeURIComponent(id)}`, {
        headers,
        signal: target.signal,
      })
      if (!response.ok) throw await responseError(response)
      body = (await response.json()) as Status & T
      if (body.sessionId !== id) throw new Error('解析服务返回了不匹配的会话')
    }
  } catch (error) {
    if (id) {
      // Cleanup uses a fresh request: an aborted opening signal must not cancel DELETE too.
      void fetch(`${base}${endpoint}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers,
        keepalive: true,
      }).catch(() => undefined)
    }
    throw error
  }
}
export function openingStateText(state: OpeningState): string {
  if (state === 'queued') return '正在排队等待解析…'
  if (state === 'previewable') return '解析中，首屏已可预览…'
  return '正在解析文档…'
}
