import type { MediaPreparation } from '@genoffice/parse-contract'
import type { MediaLoadOptions } from '@genoffice/viewer-renderers/slides/renderer/data-source'
import { fetchCapabilities } from './capabilities'

const messages: Record<string, string> = {
  media_runtime_changed: '媒体服务已升级，请重试。',
  media_invalid: '该媒体没有可用的音视频内容。',
  media_source_missing: '文档没有嵌入该媒体，或原文件已不存在。',
  media_input_limit: '媒体过大，超过当前服务的处理限制。',
  media_output_limit: '媒体转换结果超过当前服务的大小限制。',
  media_timeout: '媒体处理超时，请重试。',
  media_memory_limit: '媒体处理超过服务资源限制。',
  media_decode_failed: '该媒体无法解码或转换，请检查原文件。',
  media_queue_full: '媒体处理队列已满，请稍后重试。',
  media_cache_missing: '媒体缓存已过期，请重试。',
}

/** Online media only. Local/offline and older servers retain their original URLs. */
export async function prepareRemoteMedia(input: {
  server: string; fileId: string; token?: string;
  media: { kind: 'video' | 'audio'; dataUrl: string }; options?: MediaLoadOptions
  fetchImpl?: typeof fetch
}): Promise<{ kind: 'video' | 'audio'; dataUrl: string }> {
  input.options?.signal?.throwIfAborted()
  const base = input.server.replace(/\/+$/, '')
  const url = new URL(input.media.dataUrl, base)
  const server = new URL(base)
  const marker = `${server.pathname.replace(/\/$/, '')}/v1/files/${encodeURIComponent(input.fileId)}/parts/`
  if (url.origin !== server.origin || !url.pathname.startsWith(marker)) return input.media
  const capability = await fetchCapabilities({ baseUrl: base, signal: input.options?.signal,
    fetchImpl: input.fetchImpl })
  input.options?.signal?.throwIfAborted()
  if (capability?.features?.mediaTranscoding !== true) return input.media
  const partPath = url.pathname.slice(marker.length).split('/').map(decodeURIComponent).join('/')
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), 30 * 60_000)
  const signal = input.options?.signal ? AbortSignal.any([timeout.signal, input.options.signal]) : timeout.signal
  const headers: Record<string, string> = { 'Content-Type': 'application/json',
    ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}) }
  const fetchImpl = input.fetchImpl ?? fetch
  const endpoint = `${base}/v1/files/${encodeURIComponent(input.fileId)}/media`
  const request = async (url: string, init?: RequestInit): Promise<MediaPreparation> => {
    const response = await fetchImpl(url, { ...init, headers, signal })
    const body = await response.json() as MediaPreparation & { code?: string }
    if (!response.ok) throw new Error(messages[body.code ?? ''] ?? '媒体服务暂不可用，请稍后重试。')
    if (!/^[a-f0-9]{64}$/.test(body.jobId) || !['queued', 'processing', 'ready', 'failed'].includes(body.state))
      throw new Error('媒体服务返回了无效状态。')
    return body
  }
  try {
    input.options?.onStatus?.('正在准备媒体…')
    let state = await request(endpoint, { method: 'POST', body: JSON.stringify({ partPath,
      kind: input.media.kind, retry: input.options?.retry === true }) })
    for (;;) {
      signal.throwIfAborted()
      if (state.state === 'failed') throw new Error(messages[state.errorCode ?? ''] ?? '媒体处理失败，请重试。')
      if (state.state === 'ready') {
        if (!state.url) throw new Error('媒体资源地址缺失。')
        input.options?.onStatus?.('')
        return { kind: input.media.kind, dataUrl: state.url }
      }
      const status = state.state === 'queued' ? '媒体正在排队…'
        : state.stage === 'converting' ? `正在转换媒体（${Math.max(0, Math.min(99, state.progress))}%）…`
          : state.stage === 'verifying' ? '正在校验媒体…' : '正在检查媒体…'
      input.options?.onStatus?.(status)
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(wait); reject(signal.reason) }
        const wait = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 750)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
      state = await request(`${endpoint}/${state.jobId}`)
    }
  } finally { clearTimeout(timer) }
}
