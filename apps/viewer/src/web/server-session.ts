export type OpeningState = 'queued' | 'building'
export interface ServerSessionTarget {
  server: string
  fileId: string
  token?: string
  width?: number
  signal?: AbortSignal
  onState?: (state: OpeningState) => void
}
interface Status {
  sessionId: string
  state?: 'ready' | OpeningState | 'failed'
  pollAfterMs?: number
  error?: { message?: string; code?: string }
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

/** v2 async readiness with v1 fallback for older servers and Android's local replay server. */
export async function openServerSession<T extends { sessionId: string }>(
  target: ServerSessionTarget,
): Promise<T> {
  const base = target.server.replace(/\/+$/, '')
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (target.token) headers.Authorization = `Bearer ${target.token}`
  let endpoint = '/v2/sessions'
  let id: string | undefined
  try {
    aborted(target.signal)
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: JSON.stringify({
        fileId: target.fileId,
        ...(target.width !== undefined ? { width: target.width } : {}),
      }),
      signal: target.signal,
    }
    let response = await fetch(`${base}${endpoint}`, init)
    if (response.status === 404 || response.status === 405) {
      endpoint = '/v1/sessions'
      response = await fetch(`${base}${endpoint}`, init)
    }
    if (!response.ok) throw await responseError(response)
    let body = (await response.json()) as Status & T
    id = body.sessionId
    if (!id || typeof id !== 'string') throw new Error('解析服务未返回有效会话')
    for (;;) {
      aborted(target.signal)
      if (body.state === 'failed')
        throw new Error(body.error?.message || body.error?.code || '文档解析失败')
      if (body.state === 'ready' || (!body.state && response.status !== 202)) return body
      if (body.state !== 'queued' && body.state !== 'building')
        throw new Error('解析服务返回了未知会话状态')
      target.onState?.(body.state)
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
  return state === 'queued' ? '正在排队等待解析…' : '正在解析文档…'
}
