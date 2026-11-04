import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  CONTRACT_VERSION,
  type Capabilities,
  type DocFormat,
  type DocModel,
} from '@genoffice/parse-contract'
import { detectFormat } from './detect'
import { resolveLimits, type ServerLimits } from './limits'
import { openFilePart } from './parts'
import { parseRange } from './range'
import { signResource, verifyResource } from './sign'
import { PptxSession } from './pptx'
import { DocxSession } from './docx-session'
import { ParseLimitError } from './pptx-slim'
import { SessionStore, type SessionRecord } from './session-store'
import {
  createMetrics,
  logEvent,
  recordError,
  recordRequest,
  renderPrometheus,
  type ServerMetrics,
} from './telemetry'
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
  /** Wall-clock budget for opening a deck (slim archive + parse). */
  parseTimeoutMs?: number
  /** Wall-clock budget for one slide/font/measurement call. */
  unitTimeoutMs?: number
  /** V8 old-generation cap for the per-session parse worker. */
  workerMemoryMb?: number
  /** Concurrent PPTX sessions; further requests get 429. */
  maxSessions?: number
  /** Delete unreferenced content older than this. */
  contentTtlMs?: number
  /** Soft cap for the content store; new uploads over it get 507. */
  maxStoreBytes?: number
  /** How often to sweep unreferenced content/temp files. */
  gcIntervalMs?: number
}

export interface ParseServer {
  url: string
  port: number
  store: ContentStore
  /** Run the content GC immediately (tests/ops). */
  gc(): Promise<void>
  close(): Promise<void>
}

type SessionHandle = PptxSession | DocxSession

interface SessionEntry {
  record: SessionRecord
  session?: SessionHandle
}

interface Context {
  store: ContentStore
  sessionStore: SessionStore
  metrics: ServerMetrics
  limits: ServerLimits
  parserVersion: string
  fontSetHash: string
  token?: string
  allowedOrigins: string[]
  sessions: Map<string, SessionEntry>
  sessionTtlMs: number
  publicBaseUrl?: string
  parseTimeoutMs: number
  unitTimeoutMs: number
  workerMemoryMb: number
  maxSessions: number
  contentTtlMs: number
  maxStoreBytes: number
  gcIntervalMs: number
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
    formats: ['pptx', 'pdf', 'docx'],
    stages: {
      pptx: ['index', 'model', 'layout'],
      pdf: [],
      docx: ['index', 'model'],
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

function sessionUnits(
  model: DocModel,
  cursor?: string,
  limit = 100,
): {
  items: Array<{ id: string; kind: DocModel['unitKind']; index: number; anchor: string }>
  next?: string
} {
  const total = model.unitCount ?? 0
  const start = cursor ? Number.parseInt(cursor, 10) : 0
  if (!Number.isInteger(start) || start < 0 || start > total) {
    throw new HttpError(400, 'invalid_request', 'invalid unit cursor')
  }
  const end = Math.min(total, start + Math.max(1, Math.min(limit, 500)))
  const items = []
  for (let index = start; index < end; index++) {
    items.push({ id: String(index), kind: model.unitKind, index, anchor: String(index) })
  }
  return { items, ...(end < total ? { next: String(end) } : {}) }
}

function touchEntry(entry: SessionEntry, ctx: Context): void {
  entry.record.lastUsed = Date.now()
  void ctx.sessionStore.set(entry.record)
}

function parseFailure(error: unknown): HttpError {
  const code = (error as { code?: string })?.code
  if (error instanceof ParseLimitError || code === 'parse_limit') {
    return new HttpError(
      413,
      'file_too_large_for_parse',
      error instanceof Error ? error.message : 'slim presentation is too large',
    )
  }
  if (code === 'parse_timeout') {
    return new HttpError(504, 'parse_timeout', 'pptx parse timed out')
  }
  return new HttpError(
    422,
    'parse_failed',
    error instanceof Error ? error.message : 'pptx parse failed',
  )
}

async function ensureSession(
  entry: SessionEntry,
  req: IncomingMessage,
  ctx: Context,
): Promise<SessionHandle> {
  if (entry.session) return entry.session
  const path = await ctx.store.pathOf(entry.record.fileId)
  if (!path) throw new HttpError(404, 'not_found', 'file content is missing')
  const baseUrl = baseUrlOf(req, ctx)
  try {
    if (entry.record.model.format === 'docx') {
      entry.session = await DocxSession.open({
        id: entry.record.id,
        fileId: entry.record.fileId,
        path,
        parserVersion: entry.record.parserVersion,
        baseUrl,
        limits: ctx.limits,
        parseTimeoutMs: ctx.parseTimeoutMs,
        unitTimeoutMs: ctx.unitTimeoutMs,
        workerMemoryMb: ctx.workerMemoryMb,
        onDead: () => {
          ctx.sessions.delete(entry.record.id)
          void ctx.sessionStore.remove(entry.record.id)
        },
      })
      entry.record.baseUrl = baseUrl
      touchEntry(entry, ctx)
      return entry.session
    }
    entry.session = await PptxSession.open({
      id: entry.record.id,
      fileId: entry.record.fileId,
      path,
      width: entry.record.width,
      parserVersion: entry.record.parserVersion,
      baseUrl,
      limits: ctx.limits,
      mediaSecret: ctx.token,
      parseTimeoutMs: ctx.parseTimeoutMs,
      unitTimeoutMs: ctx.unitTimeoutMs,
      workerMemoryMb: ctx.workerMemoryMb,
      onDead: () => {
        ctx.sessions.delete(entry.record.id)
        void ctx.sessionStore.remove(entry.record.id)
      },
    })
  } catch (error) {
    throw parseFailure(error)
  }
  entry.record.baseUrl = baseUrl
  touchEntry(entry, ctx)
  return entry.session
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
  if (meta.format !== 'pptx' && meta.format !== 'docx') {
    throw new HttpError(
      415,
      'unsupported_format',
      'only pptx and docx can be opened as parse sessions',
    )
  }
  const path = await ctx.store.pathOf(fileId)
  if (!path) throw new HttpError(404, 'not_found', 'file content is missing')
  if (ctx.sessions.size >= ctx.maxSessions) {
    throw new HttpError(429, 'too_many_sessions', 'too many concurrent parse sessions')
  }
  const sessionId = randomUUID()
  const baseUrl = baseUrlOf(req, ctx)
  let session: SessionHandle
  try {
    session =
      meta.format === 'docx'
        ? await DocxSession.open({
            id: sessionId,
            fileId,
            path,
            parserVersion: ctx.parserVersion,
            baseUrl,
            limits: ctx.limits,
            parseTimeoutMs: ctx.parseTimeoutMs,
            unitTimeoutMs: ctx.unitTimeoutMs,
            workerMemoryMb: ctx.workerMemoryMb,
            onDead: () => {
              ctx.sessions.delete(sessionId)
              void ctx.sessionStore.remove(sessionId)
            },
          })
        : await PptxSession.open({
            id: sessionId,
            fileId,
            path,
            width,
            parserVersion: ctx.parserVersion,
            baseUrl,
            limits: ctx.limits,
            mediaSecret: ctx.token,
            parseTimeoutMs: ctx.parseTimeoutMs,
            unitTimeoutMs: ctx.unitTimeoutMs,
            workerMemoryMb: ctx.workerMemoryMb,
            onDead: () => {
              ctx.sessions.delete(sessionId)
              void ctx.sessionStore.remove(sessionId)
            },
          })
  } catch (error) {
    throw parseFailure(error)
  }
  ctx.metrics.sessionsCreated++
  const record: SessionRecord = {
    id: sessionId,
    fileId,
    width,
    parserVersion: ctx.parserVersion,
    baseUrl,
    model: session.model,
    fonts: session.fonts,
    createdAt: Date.now(),
    lastUsed: Date.now(),
  }
  ctx.sessions.set(sessionId, { record, session })
  await ctx.sessionStore.set(record)
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
  const entry = ctx.sessions.get(sessionId)
  if (!entry) {
    sendError(res, 404, 'not_found', 'unknown session', false, requestId)
    return
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const rest = segments.slice(3)
  if (req.method === 'DELETE' && rest.length === 0) {
    entry.session?.close()
    ctx.sessions.delete(sessionId)
    await ctx.sessionStore.remove(sessionId)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && rest.length === 0) {
    touchEntry(entry, ctx)
    sendJson(res, 200, { state: 'ready', model: entry.record.model })
    return
  }
  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'units') {
    touchEntry(entry, ctx)
    const rawLimit = Number(url.searchParams.get('limit') ?? 100)
    const limit = Number.isFinite(rawLimit) ? rawLimit : 100
    sendJson(
      res,
      200,
      sessionUnits(entry.record.model, url.searchParams.get('cursor') ?? undefined, limit),
    )
    return
  }
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'fonts') {
    const session = await ensureSession(entry, req, ctx)
    const bytes = await session.fontBytes(decodeURIComponent(rest[1]))
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
    const session = await ensureSession(entry, req, ctx)
    const measurements = await session.acceptWidths(widths)
    sendJson(res, 200, { measurements })
    return
  }
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'units') {
    try {
      const session = await ensureSession(entry, req, ctx)
      sendJson(res, 200, await session.unit(decodeURIComponent(rest[1])))
    } catch (error) {
      if (error instanceof HttpError) throw error
      const code = (error as { code?: string })?.code
      if (code === 'parse_timeout') {
        throw new HttpError(504, 'parse_timeout', 'slide render timed out')
      }
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

async function runGc(ctx: Context, keepFileId?: string): Promise<void> {
  const referenced = new Set([...ctx.sessions.values()].map((entry) => entry.record.fileId))
  const files = await ctx.store.list()
  const now = Date.now()
  const candidates = files
    .filter((file) => !referenced.has(file.fileId) && file.fileId !== keepFileId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  for (const file of candidates) {
    if (now - Date.parse(file.createdAt) <= ctx.contentTtlMs) continue
    await ctx.store.remove(file.fileId)
  }
  if (ctx.maxStoreBytes > 0) {
    let total = await ctx.store.totalBytes()
    for (const file of candidates) {
      if (total <= ctx.maxStoreBytes) break
      if (!(await ctx.store.stat(file.fileId))) continue
      await ctx.store.remove(file.fileId)
      total -= file.size
    }
  }
  await ctx.store.cleanupTemp(60 * 60_000)
}

function fileInUse(ctx: Context, fileId: string): boolean {
  return [...ctx.sessions.values()].some((entry) => entry.record.fileId === fileId)
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
  if (detected !== 'pptx' && detected !== 'pdf' && detected !== 'docx') {
    await ctx.store.abort(upload)
    sendError(
      res,
      415,
      'unsupported_format',
      `unsupported document format${detected ? ` (${detected})` : ''}; only pptx, pdf and docx are parsed`,
    )
    return
  }
  const stored = await ctx.store.commit(upload, detected)
  ctx.metrics.uploads++
  ctx.metrics.bytesUploaded += stored.size
  await runGc(ctx, stored.fileId)
  if (ctx.maxStoreBytes > 0 && (await ctx.store.totalBytes()) > ctx.maxStoreBytes) {
    await ctx.store.remove(stored.fileId)
    throw new HttpError(507, 'storage_full', 'content store is over its configured quota')
  }
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
  const startedAt = Date.now()
  res.on('finish', () => {
    recordRequest(ctx.metrics, req.method ?? 'GET', res.statusCode, Date.now() - startedAt)
    logEvent(
      res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      'http_request',
      {
        requestId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      },
    )
  })
  const segments = url.pathname.split('/').filter(Boolean)
  const isPublic =
    (req.method === 'GET' && url.pathname === '/v1/health') ||
    (req.method === 'GET' && url.pathname === '/v1/capabilities') ||
    (req.method === 'GET' && url.pathname === '/metrics')
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

  if (req.method === 'GET' && url.pathname === '/metrics') {
    const memory = process.memoryUsage()
    const body = renderPrometheus({
      metrics: ctx.metrics,
      sessions: ctx.sessions.size,
      workers: [...ctx.sessions.values()].filter((entry) => entry.session).length,
      storageBytes: await ctx.store.totalBytes(),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
      parserVersion: ctx.parserVersion,
    })
    res.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(body)
    return
  }
  if (req.method === 'GET' && url.pathname === '/v1/health') {
    const memory = process.memoryUsage()
    sendJson(res, 200, {
      ok: true,
      parserVersion: ctx.parserVersion,
      uptimeSec: Math.floor((Date.now() - ctx.metrics.startedAt) / 1000),
      sessions: ctx.sessions.size,
      activeWorkers: [...ctx.sessions.values()].filter((entry) => entry.session).length,
      requests: ctx.metrics.requests,
      errors: ctx.metrics.errors,
      uploads: ctx.metrics.uploads,
      bytesUploaded: ctx.metrics.bytesUploaded,
      sessionsCreated: ctx.metrics.sessionsCreated,
      parseTimeouts: ctx.metrics.parseTimeouts,
      tooManySessions: ctx.metrics.tooManySessions,
      storageBytes: await ctx.store.totalBytes(),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    })
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
    const part = await openFilePart(path, partPath, ctx.limits, req.headers.range)
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
        'Content-Length': String(part.contentLength),
      })
    } else {
      res.writeHead(200, { 'Content-Length': String(part.contentLength) })
    }
    if (req.method === 'HEAD') {
      part.stream.destroy()
      res.end()
      return
    }
    part.stream.on('error', () => res.destroy())
    part.stream.pipe(res)
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
    if (fileInUse(ctx, fileId)) {
      sendError(
        res,
        409,
        'file_in_use',
        'file is referenced by an active session',
        false,
        requestId,
      )
      return
    }
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
  const sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000
  const sessionStore = new SessionStore(options.dataDir)
  await sessionStore.init(sessionTtlMs)
  const ctx: Context = {
    store,
    sessionStore,
    metrics: createMetrics(),
    limits: resolveLimits(options.limits),
    parserVersion: options.parserVersion ?? '0.1.0',
    fontSetHash: options.fontSetHash ?? 'server-default',
    token: options.token,
    allowedOrigins: options.allowedOrigins ?? [],
    sessions: new Map(),
    sessionTtlMs,
    publicBaseUrl: options.publicBaseUrl,
    parseTimeoutMs: options.parseTimeoutMs ?? 60_000,
    unitTimeoutMs: options.unitTimeoutMs ?? 30_000,
    workerMemoryMb: options.workerMemoryMb ?? 512,
    maxSessions: options.maxSessions ?? 8,
    contentTtlMs: options.contentTtlMs ?? 7 * 24 * 60 * 60_000,
    maxStoreBytes: options.maxStoreBytes ?? 20 * 1024 ** 3,
    gcIntervalMs: options.gcIntervalMs ?? 10 * 60_000,
  }
  for (const record of sessionStore.values()) ctx.sessions.set(record.id, { record })
  const server: Server = createServer((req, res) => {
    const requestId = requestIdOf(req)
    route(req, res, ctx, requestId).catch((error: unknown) => {
      if (error instanceof HttpError) {
        if (error.code === 'parse_timeout') ctx.metrics.parseTimeouts++
        if (error.code === 'too_many_sessions') ctx.metrics.tooManySessions++
        recordError(ctx.metrics, error.code)
        logEvent(error.status >= 500 ? 'error' : 'warn', 'request_error', {
          requestId,
          code: error.code,
          status: error.status,
          message: error.message,
        })
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
    for (const [id, entry] of ctx.sessions) {
      if (now - entry.record.lastUsed <= ctx.sessionTtlMs) continue
      entry.session?.close()
      ctx.sessions.delete(id)
      void ctx.sessionStore.remove(id)
    }
  }, 60_000)
  sweeper.unref?.()
  const gcTimer = setInterval(() => {
    void runGc(ctx).catch((error: unknown) =>
      logEvent('warn', 'gc_failed', {
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }, ctx.gcIntervalMs)
  gcTimer.unref?.()
  const address = server.address() as AddressInfo
  const close = async (): Promise<void> => {
    clearInterval(sweeper)
    clearInterval(gcTimer)
    for (const entry of ctx.sessions.values()) entry.session?.close()
    ctx.sessions.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    await ctx.sessionStore.flush()
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    store,
    gc: () => runGc(ctx),
    close,
  }
}
