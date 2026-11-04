import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { CONTRACT_VERSION, type Capabilities, type DocFormat } from '@genoffice/parse-contract'
import { detectFormat } from './detect'
import { resolveLimits, type ServerLimits } from './limits'
import { readFilePart } from './parts'
import { parseRange } from './range'
import { signResource, verifyResource } from './sign'
import { PptxSession } from './pptx'
import { ParseLimitError } from './pptx-slim'
import { ContentStore, UploadTooLargeError, type StoredFile } from './storage'

export interface ParseServerOptions {
  /** Directory for the content-addressed store, metadata and temp uploads. */
  dataDir: string
  port?: number
  host?: string
  limits?: Partial<ServerLimits>
  parserVersion?: string
  /** Font-set fingerprint advertised to clients; layout parity depends on it. */
  fontSetHash?: string
  /** When set, every non-public route requires `Authorization: Bearer <token>`. */
  token?: string
  /** Browser origins allowed by CORS; empty means same-origin only. */
  allowedOrigins?: string[]
  /** Idle time before an open parse session is released. */
  sessionTtlMs?: number
  /** Absolute origin used in media part URLs; derived from the request when unset. */
  publicBaseUrl?: string
}

export interface ParseServer {
  url: string
  port: number
  store: ContentStore
  close(): Promise<void>
}

interface Context {
  store: ContentStore
  limits: ServerLimits
  parserVersion: string
  fontSetHash: string
  token?: string
  allowedOrigins: string[]
  sessions: Map<string, PptxSession>
  sessionTtlMs: number
  publicBaseUrl?: string
}

const CONTENT_TYPES: Record<DocFormat, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryable = false,
  requestId?: string,
): void {
  if (res.writableEnded) return
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, status, { code, message, retryable, requestId })
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > maxBytes) throw new HttpError(413, 'body_too_large', 'request body is too large')
    chunks.push(buffer)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be valid JSON')
  }
}

function requestIdOf(req: IncomingMessage): string {
  const header = req.headers['x-request-id']
  return typeof header === 'string' && header.length > 0 && header.length <= 128
    ? header
    : randomUUID()
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const origin = req.headers.origin
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Range, X-Request-Id',
    )
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Accept-Ranges, Content-Range, ETag, X-Request-Id',
    )
  }
}

function baseUrlOf(req: IncomingMessage, ctx: Context): string {
  if (ctx.publicBaseUrl) return ctx.publicBaseUrl.replace(/\/+$/, '')
  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http'
  const host = req.headers.host
  return host ? `${proto}://${host}` : ''
}

function capabilitiesOf(ctx: Context): Capabilities {
  return {
    contractVersion: CONTRACT_VERSION,
    parserVersion: ctx.parserVersion,
    // DOCX is deliberately absent: the remote parser does not support it in v1.
    formats: ['pptx', 'pdf'],
    stages: {
      pptx: ['index', 'model', 'layout'],
      pdf: [],
    },
    maxBytes: ctx.limits.maxUploadBytes,
    fontSetHash: ctx.fontSetHash,
    features: {
      lazyAssets: true,
      rangeRequests: true,
      fontWidthFeedback: true,
      streamingUnits: true,
    },
  }
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024)) as { fileId?: unknown; width?: unknown }
  const fileId = typeof body.fileId === 'string' ? body.fileId : ''
  if (!fileId) throw new HttpError(400, 'invalid_request', 'fileId is required')
  const rawWidth = Number(body.width ?? 960)
  const width = Number.isFinite(rawWidth)
    ? Math.min(4096, Math.max(320, Math.round(rawWidth)))
    : 960
  const meta = await ctx.store.stat(fileId)
  if (!meta) throw new HttpError(404, 'not_found', 'unknown file')
  if (meta.format !== 'pptx') {
    throw new HttpError(415, 'unsupported_format', 'only pptx can be opened as a slide session')
  }
  const path = await ctx.store.pathOf(fileId)
  if (!path) throw new HttpError(404, 'not_found', 'file content is missing')
  const sessionId = randomUUID()
  let session: PptxSession
  try {
    session = await PptxSession.open({
      id: sessionId,
      fileId,
      path,
      width,
      parserVersion: ctx.parserVersion,
      baseUrl: baseUrlOf(req, ctx),
      limits: ctx.limits,
      mediaSecret: ctx.token,
    })
  } catch (error) {
    if (error instanceof ParseLimitError) {
      throw new HttpError(413, 'file_too_large_for_parse', error.message)
    }
    throw new HttpError(
      422,
      'parse_failed',
      error instanceof Error ? error.message : 'pptx parse failed',
    )
  }
  ctx.sessions.set(sessionId, session)
  sendJson(res, 201, { sessionId, state: 'ready', model: session.model, fonts: session.fonts })
}

async function handleSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  url: URL,
  sessionId: string,
  requestId: string,
): Promise<void> {
  const session = ctx.sessions.get(sessionId)
  if (!session) {
    sendError(res, 404, 'not_found', 'unknown session', false, requestId)
    return
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const rest = segments.slice(3)
  if (req.method === 'DELETE' && rest.length === 0) {
    session.close()
    ctx.sessions.delete(sessionId)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && rest.length === 0) {
    session.touch()
    sendJson(res, 200, { state: 'ready', model: session.model })
    return
  }
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'fonts') {
    const bytes = session.fontBytes(decodeURIComponent(rest[1]))
    if (!bytes) {
      sendError(res, 404, 'not_found', 'unknown font', false, requestId)
      return
    }
    res.setHeader('Content-Type', 'font/ttf')
    res.setHeader('Content-Length', String(bytes.length))
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.writeHead(200)
    res.end(Buffer.from(bytes))
    return
  }
  if (req.method === 'POST' && rest.length === 1 && rest[0] === 'text-widths') {
    const body = (await readJsonBody(req, 2 * 1024 * 1024)) as {
      widths?: Array<{ key?: unknown; width?: unknown }>
    }
    if (!Array.isArray(body.widths)) {
      throw new HttpError(400, 'invalid_request', 'widths must be an array')
    }
    const widths: Record<string, number> = {}
    for (const item of body.widths) {
      if (typeof item?.key !== 'string') continue
      if (typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width < 0) continue
      widths[item.key] = item.width
    }
    session.acceptWidths(widths)
    sendJson(res, 200, { measurements: session.pendingMeasurements() })
    return
  }
  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'units') {
    session.touch()
    const rawLimit = Number(url.searchParams.get('limit') ?? 100)
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100
    sendJson(res, 200, session.units(url.searchParams.get('cursor') ?? undefined, limit))
    return
  }
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'units') {
    session.touch()
    try {
      sendJson(res, 200, session.unit(decodeURIComponent(rest[1])))
    } catch (error) {
      throw new HttpError(
        404,
        'not_found',
        error instanceof Error ? error.message : 'unknown slide',
      )
    }
    return
  }
  sendError(res, 404, 'not_found', 'unknown route', false, requestId)
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > ctx.limits.maxUploadBytes) {
    req.resume()
    sendError(
      res,
      413,
      'upload_too_large',
      `file exceeds the ${ctx.limits.maxUploadBytes}-byte limit`,
    )
    return
  }
  let upload
  try {
    upload = await ctx.store.writeTemp(req, ctx.limits.maxUploadBytes)
  } catch (error) {
    if (error instanceof UploadTooLargeError) {
      sendError(res, 413, 'upload_too_large', error.message)
      return
    }
    throw error
  }
  let detected: Awaited<ReturnType<typeof detectFormat>>
  try {
    detected = await detectFormat(upload.tempPath, ctx.limits)
  } catch (error) {
    await ctx.store.abort(upload)
    throw error
  }
  if (detected !== 'pptx' && detected !== 'pdf') {
    await ctx.store.abort(upload)
    sendError(
      res,
      415,
      'unsupported_format',
      `unsupported document format${detected ? ` (${detected})` : ''}; only pptx and pdf are parsed`,
    )
    return
  }
  const stored = await ctx.store.commit(upload, detected)
  sendJson(res, 201, stored)
}

async function handleContent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  meta: StoredFile,
): Promise<void> {
  const range = parseRange(req.headers.range, meta.size)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${meta.size}` })
    res.end()
    return
  }
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('ETag', `"${meta.sha256}"`)
  res.setHeader('Content-Type', CONTENT_TYPES[meta.format])
  res.setHeader('Cache-Control', 'private, max-age=0')
  if (range) {
    res.writeHead(206, {
      'Content-Range': `bytes ${range.start}-${range.end}/${meta.size}`,
      'Content-Length': String(range.end - range.start + 1),
    })
  } else {
    res.writeHead(200, { 'Content-Length': String(meta.size) })
  }
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = range
    ? await ctx.store.readRange(meta.fileId, range.start, range.end)
    : await ctx.store.readRange(meta.fileId, 0, meta.size - 1)
  if (!stream) {
    sendError(res, 404, 'not_found', 'file content is missing')
    return
  }
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  requestId: string,
): Promise<void> {
  applyCors(req, res, ctx.allowedOrigins)
  res.setHeader('X-Request-Id', requestId)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const segments = url.pathname.split('/').filter(Boolean)
  const isPublic =
    (req.method === 'GET' && url.pathname === '/v1/health') ||
    (req.method === 'GET' && url.pathname === '/v1/capabilities')
  if (!isPublic && ctx.token) {
    // <img>/<video>/PDF.js cannot send Authorization: content and part URLs
    // carry an HMAC signature instead of the bearer token.
    let signed = false
    if (
      req.headers.authorization !== `Bearer ${ctx.token}` &&
      segments[0] === 'v1' &&
      segments[1] === 'files' &&
      segments[2]
    ) {
      const fileId = decodeURIComponent(segments[2])
      let resource: string | null = null
      if (segments[3] === 'content') resource = 'content'
      else if (segments[3] === 'parts' && segments.length >= 5)
        resource = segments
          .slice(4)
          .map((segment) => decodeURIComponent(segment))
          .join('/')
      if (resource) {
        const exp = Number(url.searchParams.get('exp'))
        const sig = url.searchParams.get('sig') ?? ''
        signed = verifyResource(ctx.token, fileId, resource, exp, sig)
      }
    }
    if (req.headers.authorization !== `Bearer ${ctx.token}` && !signed) {
      sendError(res, 401, 'unauthorized', 'a bearer token is required', false, requestId)
      return
    }
  }

  if (req.method === 'GET' && url.pathname === '/v1/health') {
    sendJson(res, 200, { ok: true, parserVersion: ctx.parserVersion })
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/capabilities') {
    sendJson(res, 200, capabilitiesOf(ctx))
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/sessions') {
    await handleCreateSession(req, res, ctx)
    return
  }
  if (segments[0] === 'v1' && segments[1] === 'sessions' && segments[2]) {
    await handleSession(req, res, ctx, url, decodeURIComponent(segments[2]), requestId)
    return
  }
  if (req.method === 'POST' && url.pathname === '/v1/files') {
    await handleUpload(req, res, ctx)
    return
  }
  if (segments[0] !== 'v1' || segments[1] !== 'files' || !segments[2]) {
    sendError(res, 404, 'not_found', 'unknown route', false, requestId)
    return
  }
  const fileId = decodeURIComponent(segments[2])
  const meta = await ctx.store.stat(fileId)
  if (!meta) {
    sendError(res, 404, 'not_found', 'unknown file', false, requestId)
    return
  }
  if (segments.length === 4 && segments[3] === 'content-url' && req.method === 'GET') {
    const base = baseUrlOf(req, ctx)
    const plain = `${base}/v1/files/${encodeURIComponent(fileId)}/content`
    if (!ctx.token) {
      sendJson(res, 200, { url: plain })
      return
    }
    const { exp, sig } = signResource(ctx.token, fileId, 'content')
    sendJson(res, 200, {
      url: `${plain}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    })
    return
  }
  if (segments.length === 3 && (req.method === 'GET' || req.method === 'HEAD')) {
    const payload = JSON.stringify(meta)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
    })
    res.end(req.method === 'HEAD' ? undefined : payload)
    return
  }
  if (
    segments.length >= 5 &&
    segments[3] === 'parts' &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const partPath = segments
      .slice(4)
      .map((segment) => decodeURIComponent(segment))
      .join('/')
    const path = await ctx.store.pathOf(fileId)
    if (!path) {
      sendError(res, 404, 'not_found', 'file content is missing', false, requestId)
      return
    }
    const part = await readFilePart(path, partPath, ctx.limits, req.headers.range)
    if (!part) {
      sendError(res, 404, 'not_found', 'unknown part', false, requestId)
      return
    }
    if ('invalidRange' in part) {
      res.writeHead(416, { 'Content-Range': `bytes */${part.size}` })
      res.end()
      return
    }
    res.setHeader('Content-Type', part.mime)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.setHeader('ETag', `"${meta.sha256}:${partPath}"`)
    if (part.ranged && part.range) {
      res.writeHead(206, {
        'Content-Range': `bytes ${part.range.start}-${part.range.end}/${part.size}`,
        'Content-Length': String(part.bytes.length),
      })
    } else {
      res.writeHead(200, { 'Content-Length': String(part.bytes.length) })
    }
    res.end(req.method === 'HEAD' ? undefined : part.bytes)
    return
  }
  if (
    segments.length === 4 &&
    segments[3] === 'content' &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    await handleContent(req, res, ctx, meta)
    return
  }
  if (segments.length === 3 && req.method === 'DELETE') {
    await ctx.store.remove(fileId)
    res.writeHead(204)
    res.end()
    return
  }
  sendError(res, 404, 'not_found', 'unknown route', false, requestId)
}

export async function createParseServer(options: ParseServerOptions): Promise<ParseServer> {
  const store = new ContentStore(options.dataDir)
  await store.init()
  const ctx: Context = {
    store,
    limits: resolveLimits(options.limits),
    parserVersion: options.parserVersion ?? '0.1.0',
    fontSetHash: options.fontSetHash ?? 'server-default',
    token: options.token,
    allowedOrigins: options.allowedOrigins ?? [],
    sessions: new Map(),
    sessionTtlMs: options.sessionTtlMs ?? 15 * 60_000,
    publicBaseUrl: options.publicBaseUrl,
  }
  const server: Server = createServer((req, res) => {
    const requestId = requestIdOf(req)
    route(req, res, ctx, requestId).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message, false, requestId)
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendError(res, 500, 'internal_error', message, true, requestId)
    })
  })
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of ctx.sessions) {
      if (now - session.idleSince() <= ctx.sessionTtlMs) continue
      session.close()
      ctx.sessions.delete(id)
    }
  }, 60_000)
  sweeper.unref?.()
  const address = server.address() as AddressInfo
  const close = async (): Promise<void> => {
    clearInterval(sweeper)
    for (const session of ctx.sessions.values()) session.close()
    ctx.sessions.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    store,
    close,
  }
}
