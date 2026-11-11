import { open } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MediaService } from './media-service'
import { MediaError } from './media-process'
import { parseRange } from './range'
import { signResource } from './sign'

/** Caller applies normal file authorization and source-file existence checks. */
export async function handleMedia(req: IncomingMessage, res: ServerResponse, input: {
  media?: MediaService; fileId: string; rest: string[]; baseUrl: string; token?: string;
  readJson: () => Promise<unknown>
}): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body))
  }
  if (!input.media) { send(404, { code: 'media_disabled', message: '媒体转换未启用。' }); return }
  try {
    let id = input.rest[0]
    if (req.method === 'POST' && input.rest.length === 0) {
      if (!input.media.options.enabled) { send(404, { code: 'media_disabled' }); return }
      const body = await input.readJson() as { partPath?: unknown; kind?: unknown; retry?: unknown }
      if (!body || typeof body.partPath !== 'string' || !['audio', 'video'].includes(String(body.kind)) ||
          (body.retry !== undefined && typeof body.retry !== 'boolean'))
        throw new MediaError('media_invalid_request', '无效的媒体准备请求。')
      id = (await input.media.prepare(input.fileId, body.partPath, body.kind as 'audio' | 'video', body.retry === true)).id
    } else if (!['GET', 'HEAD'].includes(req.method ?? '') || !id || input.rest.length > 2 ||
        (input.rest.length === 2 && input.rest[1] !== 'content')) {
      send(404, { code: 'not_found' }); return
    }
    if (!id) { send(404, { code: 'not_found' }); return }
    const status = await input.media.status(input.fileId, id)
    if (!status) { send(404, { code: 'not_found' }); return }
    if (input.rest[1] !== 'content') {
      if (status.result) {
        let url = `${input.baseUrl}/v1/files/${input.fileId}/media/${id}/content`
        if (input.token) {
          const { exp, sig } = signResource(input.token, input.fileId, `media:${id}`)
          url += `?exp=${exp}&sig=${sig}`
        }
        status.dto.url = url
      }
      send(status.dto.state === 'queued' || status.dto.state === 'processing' ? 202 : 200, status.dto)
      return
    }
    if (!status.result) { send(409, status.dto); return }
    const result = status.result
    const etag = `"${result.sha256}"`
    // Open the inode before streaming so a concurrent LRU unlink cannot truncate it.
    const file = await open(input.media.path(result), 'r')
    const info = await file.stat()
    if (info.size !== result.bytes) { await file.close(); send(409, { code: 'media_cache_missing' }); return }
    const range = parseRange(!req.headers['if-range'] || req.headers['if-range'] === etag ? req.headers.range : undefined, result.bytes)
    res.setHeader('ETag', etag)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('Content-Type', result.mime)
    if (range === 'invalid') {
      await file.close(); res.writeHead(416, { 'Content-Range': `bytes */${result.bytes}` }); res.end(); return
    }
    if (req.headers['if-none-match'] === etag && !req.headers.range) {
      await file.close(); res.writeHead(304); res.end(); return
    }
    const length = range ? range.end - range.start + 1 : result.bytes
    res.setHeader('Content-Length', length)
    if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${result.bytes}`)
    res.writeHead(range ? 206 : 200)
    if (req.method === 'HEAD') { await file.close(); res.end(); return }
    const stream = file.createReadStream(range ? { start: range.start, end: range.end } : {})
    stream.once('error', () => res.destroy())
    res.once('close', () => stream.destroy())
    stream.pipe(res)
  } catch (error) {
    if (res.headersSent) { res.destroy(); return }
    if ((error as { code?: string }).code === 'ENOENT') {
      send(409, { code: 'media_cache_missing', message: '媒体缓存已过期，请重新准备。' }); return
    }
    if (error instanceof MediaError) {
      if (error.code === 'media_queue_full') res.setHeader('Retry-After', '2')
      send(error.code === 'media_queue_full' ? 429 : error.code === 'media_source_missing' ? 404 : 400,
        { code: error.code, message: error.message, retryable: error.code === 'media_queue_full' })
    } else throw error
  }
}
