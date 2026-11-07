import { ArtifactCoordinator } from './artifact-coordinator'
import { ArtifactReadHandle } from './artifact-read-handle'
import { StorageBudget } from './storage-budget'
import { statfs } from 'node:fs/promises'
import { PendingSessionStore, type PendingSession } from './pending-session-store'
import { artifactKey } from './artifact-store'
import { isolatedMemory } from './isolated-worker'
import { validateRuntimeOptions } from './runtime-options'
import { FileLifecycle } from './file-lifecycle'
import { LibraryStore } from './library-store'
import { ParseQueue } from './parse-queue'
import { ArtifactStore, ArtifactCorruptionError } from './artifact-store'
import { ArtifactSession } from './artifact-session'
import { MysqlArtifactCatalog } from './artifact-catalog'
import { ArtifactGenerations } from './artifact-generations'
import { ArtifactGenerationSweeper } from './artifact-generation-sweeper'
import { ArtifactCollectionService } from './artifact-collection-service'
import { parserFingerprint } from './parser-fingerprint'
import { refreshDocxResourceUrls } from './resource-urls'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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
import { chunkDir, collectOrphanChunks, removeChunks } from './docx-chunks'
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
import { MysqlDatabase, type MysqlConfig } from './mysql'

export interface ParseServerOptions {
  /** Directory for the content-addressed store, metadata and temp uploads. */
  dataDir: string
  /** Staged primary-model migration; catalog requires MySQL. */
  artifactBackend?: 'local' | 'catalog'
  port?: number
  host?: string
  limits?: Partial<ServerLimits>
  parserVersion?: string
  /** Build-generated fingerprint for packaged deployments; source mode hashes parser inputs. */
  parserFingerprint?: string
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
  /** V8 old-generation cap for an isolated parse/layout process. */
  workerMemoryMb?: number
  /** External RSS cap; use a delegated cgroup for a kernel-enforced cap. */
  workerRssMb?: number
  /** Total memory reserved by concurrently running compute jobs. */
  parseMemoryMb?: number
  rssSampleMs?: number
  cgroupRoot?: string
  /** Total child lifetime, including startup and all export RPCs. */
  workerLifetimeMs?: number
  /** Lightweight reading session limit, independent of parse concurrency. */
  maxSessions?: number
  maxParseJobs?: number
  maxQueuedParseJobs?: number
  /** Delete unreferenced content older than this. */
  contentTtlMs?: number
  /** Soft cap for the content store; new uploads over it get 507. */
  maxStoreBytes?: number
  storageHighWaterPercent?: number
  storageLowWaterPercent?: number
  /** How often to sweep unreferenced content/temp files. */
  gcIntervalMs?: number
  /** MySQL persistence for file metadata and sessions; unset = filesystem only. */
  mysql?: MysqlConfig
}

export interface ParseServer {
  url: string
  port: number
  store: ContentStore
  /** Run the content GC immediately (tests/ops). */
  gc(): Promise<void>
  close(): Promise<void>
  db?: MysqlDatabase
}

type SessionHandle = ArtifactSession

interface SessionEntry {
  record: SessionRecord
  session?: SessionHandle
  opening?: Promise<SessionHandle>
}

interface Context {
  store: ContentStore
  artifacts: ArtifactStore
  gcFlights: Set<Promise<void>>
  sessionDisposals: Set<Promise<void>>
  sessionDisposalByHandle: WeakMap<SessionHandle, Promise<void>>
  artifactCatalog?: MysqlArtifactCatalog
  sharedArtifacts?: { catalog: MysqlArtifactCatalog; disk: ArtifactGenerations; coordinator: ArtifactCoordinator }
  generationCollection?: ArtifactCollectionService
  storageBudget: StorageBudget
  library: LibraryStore
  files: FileLifecycle
  parseQueue: ParseQueue
  parserFingerprint: string
  sessionStore: SessionStore
  pendingViews: PendingSessionStore
  asyncFlights: Map<string, Promise<void>>
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
  workerRssMb: number
  rssSampleMs: number
  cgroupRoot?: string
  workerLifetimeMs: number
  processGroup: string
  maxSessions: number
  pendingSessions: number
  pendingSessionIds: Set<string>
  closing: boolean
  contentTtlMs: number
  maxStoreBytes: number
  gcIntervalMs: number
  chunkRoot: string
  db?: MysqlDatabase
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
      asyncSessions: true,
      historyLibrary: true,
      offlineBundles: true,
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
  void ctx.sessionStore.set(entry.record).catch((error: unknown) =>
    logEvent('warn', 'session_touch_failed', {
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}

function parseFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const code = (error as { code?: string })?.code
  if (code === 'storage_full')
    return new HttpError(507, code, 'insufficient storage for parsed artifact')
  if (code === 'parse_memory_limit')
    return new HttpError(422, code, 'parser process exceeded its memory budget')
  if (code === 'parse_memory_monitor_failed')
    return new HttpError(503, code, 'parser memory enforcement is unavailable')
  if (code === 'parse_memory_budget')
    return new HttpError(413, code, 'job exceeds total parse memory budget')
  if (code === 'parse_queue_full')
    return new HttpError(429, code, 'parse queue is full; retry later')
  if (code === 'artifact_corrupt')
    return new HttpError(503, code, 'parsed artifact is damaged; retry')
  if (error instanceof ParseLimitError || code === 'parse_limit') {
    return new HttpError(
      413,
      'file_too_large_for_parse',
      error instanceof Error ? error.message : 'slim presentation is too large',
    )
  }
  if (code === 'parse_timeout') {
    return new HttpError(504, 'parse_timeout', 'document parse timed out')
  }
  return new HttpError(
    422,
    'parse_failed',
    error instanceof Error ? error.message : 'pptx parse failed',
  )
}

function openDocument(ctx: Context, ...args: Parameters<typeof ArtifactSession.open>): Promise<ArtifactSession> {
  const [store, input, queue, onAdmission] = args
  return ctx.sharedArtifacts
    ? ArtifactSession.openShared(store, input, ctx.sharedArtifacts, queue, onAdmission)
    : ArtifactSession.open(...args)
}

/** Begin cancellation synchronously; keep asynchronous worker/lease cleanup owned by the server. */
function closeSession(session: SessionHandle | undefined, ctx: Context): void {
  if (!session || ctx.sessionDisposalByHandle.has(session)) return
  session.close()
  const work = Promise.resolve().then(() => session.dispose())
  ctx.sessionDisposalByHandle.set(session, work)
  ctx.sessionDisposals.add(work)
  void work.finally(() => ctx.sessionDisposals.delete(work)).catch((error) => {
    logEvent('warn', 'session_disposal_failed', { message: error instanceof Error ? error.message : String(error) })
  })
}

async function ensureSession(
  entry: SessionEntry,
  req: IncomingMessage,
  ctx: Context,
): Promise<SessionHandle> {
  if (entry.opening) return entry.opening
  touchEntry(entry, ctx)
  const pending = openRestoredSession(entry, req, ctx)
  entry.opening = pending
  try {
    const session = await pending
    if (ctx.closing || ctx.sessions.get(entry.record.id) !== entry) {
      closeSession(session, ctx)
      await ctx.sessionStore.remove(entry.record.id)
      await removeChunks(chunkDir(ctx.chunkRoot, entry.record.id))
      throw new HttpError(404, 'not_found', 'session closed while reopening')
    }
    return session
  } finally {
    if (entry.opening === pending) entry.opening = undefined
  }
}

async function openRestoredSession(
  entry: SessionEntry,
  req: IncomingMessage,
  ctx: Context,
): Promise<SessionHandle> {
  if (entry.session) {
    touchEntry(entry, ctx)
    return entry.session
  }
  const path = await ctx.store.pathOf(entry.record.fileId)
  if (!path) throw new HttpError(404, 'not_found', 'file content is missing')
  const baseUrl = baseUrlOf(req, ctx)
  try {
    entry.session = await openDocument(ctx,
      ctx.artifacts,
      {
        id: entry.record.id,
        fileId: entry.record.fileId,
        path,
        width: entry.record.width,
        format: entry.record.model.format as 'pptx' | 'docx',
        parserVersion: ctx.parserVersion,
        parserFingerprint: ctx.parserFingerprint,
        baseUrl,
        limits: ctx.limits,
        mediaSecret: ctx.token,
        parseTimeoutMs: ctx.parseTimeoutMs,
        unitTimeoutMs: ctx.unitTimeoutMs,
        workerMemoryMb: ctx.workerMemoryMb,
        workerRssMb: ctx.workerRssMb,
        rssSampleMs: ctx.rssSampleMs,
        cgroupRoot: ctx.cgroupRoot,
        workerLifetimeMs: ctx.workerLifetimeMs,
        processGroup: ctx.processGroup,
        chunkRoot: ctx.chunkRoot,
      },
      ctx.parseQueue,
    )
  } catch (error) {
    throw parseFailure(error)
  }
  entry.record.baseUrl = baseUrl
  entry.record.model = entry.session.model
  entry.record.fonts = entry.session.fonts
  entry.record.parserVersion = ctx.parserVersion
  touchEntry(entry, ctx)
  return entry.session
}

async function handleCreateSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024)) as { fileId?: unknown; width?: unknown } | null
  const fileId = typeof body?.fileId === 'string' ? body.fileId : ''
  if (!fileId) throw new HttpError(400, 'invalid_request', 'fileId is required')
  const release = await ctx.files.acquire(fileId)
  try {
    const rawWidth = Number(body?.width ?? 960)
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
    if (
      ctx.sessions.size + ctx.pendingSessions + ctx.pendingViews.values().length >=
      ctx.maxSessions
    ) {
      throw new HttpError(429, 'too_many_sessions', 'too many concurrent parse sessions')
    }
    const sessionId = randomUUID()
    const baseUrl = baseUrlOf(req, ctx)
    let session: SessionHandle
    ctx.pendingSessions++
    ctx.pendingSessionIds.add(sessionId)
    try {
      session = await openDocument(ctx,
        ctx.artifacts,
        {
          id: sessionId,
          fileId,
          path,
          width,
          format: meta.format,
          parserVersion: ctx.parserVersion,
          parserFingerprint: ctx.parserFingerprint,
          baseUrl,
          limits: ctx.limits,
          mediaSecret: ctx.token,
          parseTimeoutMs: ctx.parseTimeoutMs,
          unitTimeoutMs: ctx.unitTimeoutMs,
          workerMemoryMb: ctx.workerMemoryMb,
          workerRssMb: ctx.workerRssMb,
          rssSampleMs: ctx.rssSampleMs,
          cgroupRoot: ctx.cgroupRoot,
          workerLifetimeMs: ctx.workerLifetimeMs,
          processGroup: ctx.processGroup,
          chunkRoot: ctx.chunkRoot,
        },
        ctx.parseQueue,
      )
    } catch (error) {
      throw parseFailure(error)
    } finally {
      ctx.pendingSessions--
      ctx.pendingSessionIds.delete(sessionId)
    }
    if (ctx.closing) {
      closeSession(session, ctx)
      throw new HttpError(503, 'server_stopping', 'server is stopping')
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
  } finally {
    release()
  }
}

function pendingBody(ctx: Context, record: PendingSession) {
  const phase = ctx.artifacts.phase(record.artifactKey)
  if (phase === 'building') ctx.pendingViews.observeBuilding(record.id)
  return {
    sessionId: record.id,
    jobId: record.jobId,
    artifactKey: record.artifactKey,
    state: record.error ? 'failed' : record.state === 'building' ? 'building' : phase,
    pollAfterMs: 500,
    ...(record.error ? { error: record.error } : {}),
  }
}

function startAsyncWork(
  ctx: Context,
  record: PendingSession,
  onAdmission?: () => void,
): Promise<void> {
  const existing = ctx.asyncFlights.get(record.id)
  if (existing) return existing
  const work = (async () => {
    let release: (() => void) | undefined
    ctx.pendingSessionIds.add(record.id)
    try {
      if (
        record.parserVersion !== ctx.parserVersion ||
        record.parserFingerprint !== ctx.parserFingerprint ||
        record.artifactKey !==
          artifactKey(
            ArtifactSession.identity({
              fileId: record.fileId,
              format: record.format,
              parserVersion: ctx.parserVersion,
              parserFingerprint: ctx.parserFingerprint,
            }),
          )
      ) {
        throw new HttpError(409, 'parser_version_changed', 'parser changed; reopen the document')
      }
      release = await ctx.files.acquire(record.fileId)
      const path = await ctx.store.pathOf(record.fileId)
      if (!path) throw new HttpError(404, 'not_found', 'file content is missing')
      const session = await openDocument(ctx,
        ctx.artifacts,
        {
          id: record.id,
          fileId: record.fileId,
          format: record.format,
          path,
          width: record.width,
          parserVersion: ctx.parserVersion,
          parserFingerprint: ctx.parserFingerprint,
          baseUrl: ctx.publicBaseUrl ?? 'http://artifact.invalid',
          limits: ctx.limits,
          mediaSecret: ctx.token,
          parseTimeoutMs: ctx.parseTimeoutMs,
          unitTimeoutMs: ctx.unitTimeoutMs,
          workerMemoryMb: ctx.workerMemoryMb,
          workerRssMb: ctx.workerRssMb,
          rssSampleMs: ctx.rssSampleMs,
          cgroupRoot: ctx.cgroupRoot,
          workerLifetimeMs: ctx.workerLifetimeMs,
          processGroup: ctx.processGroup,
          chunkRoot: ctx.chunkRoot,
        },
        ctx.parseQueue,
        onAdmission,
      )
      try {
        if (ctx.closing || !ctx.pendingViews.get(record.id)) return
        const ready: SessionRecord = {
          id: record.id,
          fileId: record.fileId,
          width: record.width,
          parserVersion: ctx.parserVersion,
          baseUrl: '',
          model: session.model,
          fonts: session.fonts,
          createdAt: record.createdAt,
          lastUsed: Date.now(),
        }
        await ctx.sessionStore.set(ready)
        if (!ctx.pendingViews.get(record.id)) {
          await ctx.sessionStore.remove(record.id)
          return
        }
        ctx.sessions.set(record.id, { record: ready })
        await ctx.pendingViews.remove(record.id)
      } finally {
        closeSession(session, ctx)
      }
    } catch (error) {
      if (!ctx.closing && ctx.pendingViews.get(record.id)) {
        const failure = parseFailure(error)
        recordError(ctx.metrics, failure.code)
        if (failure.code === 'parse_timeout') ctx.metrics.parseTimeouts++
        await ctx.pendingViews.fail(record.id, {
          status: failure.status,
          code: failure.code,
          message: failure.message,
        })
      }
    } finally {
      release?.()
      ctx.pendingSessionIds.delete(record.id)
    }
  })()
    .catch((error: unknown) =>
      logEvent('error', 'async_session_state_failed', {
        sessionId: record.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    .finally(() => {
      if (ctx.asyncFlights.get(record.id) === work) ctx.asyncFlights.delete(record.id)
    })
  ctx.asyncFlights.set(record.id, work)
  return work
}

async function discardAsyncView(ctx: Context, id: string): Promise<void> {
  await ctx.pendingViews.remove(id)
  const ready = ctx.sessions.get(id)
  if (ready) {
    closeSession(ready.session, ctx)
    ctx.sessions.delete(id)
    await ctx.sessionStore.remove(id)
  }
}

async function handleCreateAsyncSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  const body = (await readJsonBody(req, 64 * 1024)) as { fileId?: unknown; width?: unknown } | null
  if (
    !body ||
    Array.isArray(body) ||
    typeof body.fileId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.fileId)
  ) {
    throw new HttpError(400, 'invalid_request', 'fileId is required')
  }
  const fileId = body.fileId
  const release = await ctx.files.acquire(fileId)
  try {
    const meta = await ctx.store.stat(fileId)
    if (!meta || !(await ctx.store.pathOf(fileId)))
      throw new HttpError(404, 'not_found', 'file content is missing')
    if (meta.format !== 'pptx' && meta.format !== 'docx')
      throw new HttpError(415, 'unsupported_format', 'only pptx and docx support parse sessions')
    if (
      ctx.sessions.size + ctx.pendingSessions + ctx.pendingViews.values().length >=
      ctx.maxSessions
    )
      throw new HttpError(429, 'too_many_sessions', 'too many reading sessions')
    const rawWidth = Number(body.width ?? 960)
    const width = Number.isFinite(rawWidth)
      ? Math.min(4096, Math.max(320, Math.round(rawWidth)))
      : 960
    const key = artifactKey(
      ArtifactSession.identity({
        fileId,
        format: meta.format,
        parserVersion: ctx.parserVersion,
        parserFingerprint: ctx.parserFingerprint,
      }),
    )
    let cached = false
    try {
      const reader = ctx.sharedArtifacts
        ? await ArtifactReadHandle.open(ctx.sharedArtifacts.catalog, ctx.sharedArtifacts.disk, key, `probe:${randomUUID()}`)
        : await ctx.artifacts.find(key)
      try { if (reader) {
        if (!reader.has('document'))
          throw new ArtifactCorruptionError('artifact document record missing')
        await reader.read('document')
        cached = true
      } } finally { if (reader instanceof ArtifactReadHandle) await reader.close() }
    } catch (error) {
      if (!(error instanceof ArtifactCorruptionError)) throw error
      // The shared build path owns invalidation and repair; probing never deletes.
    }
    const now = Date.now()
    ctx.pendingSessions++
    let record: PendingSession
    try {
      record = await ctx.pendingViews.create({
        id: randomUUID(),
        artifactKey: key,
        fileId,
        format: meta.format,
        width,
        parserVersion: ctx.parserVersion,
        parserFingerprint: ctx.parserFingerprint,
        createdAt: now,
        lastUsed: now,
      })
    } finally {
      ctx.pendingSessions--
    }
    res.once('close', () => {
      if (!res.writableFinished)
        void discardAsyncView(ctx, record.id).catch((error: unknown) =>
          logEvent('warn', 'async_view_cleanup_failed', { message: String(error) }),
        )
    })
    if (res.destroyed) {
      await discardAsyncView(ctx, record.id)
      return
    }
    let admit!: () => void
    const admission = new Promise<void>((resolve) => {
      admit = resolve
    })
    const work = startAsyncWork(ctx, record, admit)
    if (cached) await work
    else await Promise.race([admission, work])
    const ready = ctx.sessions.get(record.id)
    if (ready) {
      ctx.metrics.sessionsCreated++
      sendJson(res, 201, {
        sessionId: record.id,
        jobId: record.jobId,
        state: 'ready',
        model: ready.record.model,
        fonts: ready.record.fonts,
      })
      return
    }
    const pending = ctx.pendingViews.get(record.id)
    if (!pending) throw new HttpError(503, 'server_stopping', 'session was closed')
    if (pending.error) {
      await ctx.pendingViews.remove(record.id)
      throw new HttpError(pending.error.status, pending.error.code, pending.error.message)
    }
    ctx.metrics.sessionsCreated++
    res.setHeader('Location', `/v2/sessions/${record.id}`)
    res.setHeader('Retry-After', '1')
    sendJson(res, 202, pendingBody(ctx, pending))
  } finally {
    release()
  }
}

async function handleOfflineBundle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  entry: SessionEntry,
  parts: string[],
): Promise<void> {
  await pinResponseFile(ctx, entry.record.fileId, res)
  const session = await ensureSession(entry, req, ctx)
  if (session.model.format !== 'pptx')
    throw new HttpError(415, 'unsupported_format', 'offline bundles currently require PPTX')
  res.setHeader('Cache-Control', 'private, no-store')
  if (parts.length === 4 && req.method === 'GET') {
    const manifest = await session.bundleManifest().catch((error: unknown) => {
      throw parseFailure(error)
    })
    if (res.destroyed || res.writableFinished) return
    sendJson(res, 200, {
      ...manifest,
      resources: manifest.resources.map((resource) => ({
        ...resource,
        href: `/v2/sessions/${encodeURIComponent(entry.record.id)}/bundle/resources/${resource.path.split('/').map(encodeURIComponent).join('/')}`,
      })),
    })
    return
  }
  if (parts[4] !== 'resources' || parts.length < 6)
    throw new HttpError(404, 'not_found', 'unknown bundle route')
  let path: string
  try {
    path = parts.slice(5).map(decodeURIComponent).join('/')
  } catch {
    throw new HttpError(400, 'invalid_request', 'malformed bundle resource path')
  }
  const resource = await session.bundleResource(path).catch((error: unknown) => {
    throw parseFailure(error)
  })
  if (res.destroyed || res.writableFinished) return
  if (!resource) throw new HttpError(404, 'not_found', 'unknown bundle resource')
  const etag = `"${resource.info.sha256}"`
  const rangeHeader =
    !req.headers['if-range'] || req.headers['if-range'] === etag ? req.headers.range : undefined
  res.setHeader('ETag', etag)
  res.setHeader('Accept-Ranges', 'bytes')
  if (resource.partPath && resource.info.size > 0) {
    const source = await ctx.store.pathOf(entry.record.fileId)
    if (!source) throw new HttpError(404, 'not_found', 'bundle source is missing')
    const part = await openFilePart(source, resource.partPath, ctx.limits, rangeHeader)
    if (!part) throw new HttpError(404, 'not_found', 'bundle part is missing')
    if ('invalidRange' in part) {
      res.writeHead(416, { 'Content-Range': `bytes */${part.size}` })
      res.end()
      return
    }
    res.setHeader('Content-Type', part.mime)
    res.setHeader('Content-Length', part.contentLength)
    if (part.ranged && part.range)
      res.setHeader('Content-Range', `bytes ${part.range.start}-${part.range.end}/${part.size}`)
    res.writeHead(part.ranged ? 206 : 200)
    if (req.method === 'HEAD') {
      part.stream.destroy()
      res.end()
      return
    }
    res.once('close', () => part.stream.destroy())
    part.stream.once('error', () => res.destroy())
    part.stream.pipe(res)
    return
  }
  const bytes = resource.bytes ?? Buffer.alloc(0)
  const range = parseRange(rangeHeader, bytes.length)
  if (range === 'invalid') {
    res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` })
    res.end()
    return
  }
  const payload = range ? bytes.subarray(range.start, range.end + 1) : bytes
  res.setHeader(
    'Content-Type',
    path.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
  )
  res.setHeader('Content-Length', payload.length)
  if (range) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${bytes.length}`)
  res.writeHead(range ? 206 : 200)
  res.end(req.method === 'HEAD' ? undefined : payload)
}

async function handleAsyncSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  url: URL,
  id: string,
  requestId: string,
): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store')
  const parts = url.pathname.split('/').filter(Boolean)
  const root = parts.length === 3
  const pending = ctx.pendingViews.get(id)
  if (req.method === 'DELETE' && root) {
    if (!pending && !ctx.sessions.has(id)) throw new HttpError(404, 'not_found', 'unknown session')
    await discardAsyncView(ctx, id)
    res.writeHead(204)
    res.end()
    return
  }
  if (!ctx.sessions.has(id)) {
    if (!pending) throw new HttpError(404, 'not_found', 'unknown session')
    await ctx.pendingViews.touch(id)
  }
  const entry = ctx.sessions.get(id)
  if (entry) {
    if (parts[3] === 'bundle' && (req.method === 'GET' || req.method === 'HEAD')) {
      await handleOfflineBundle(req, res, ctx, entry, parts)
      return
    }
    if (
      req.method === 'GET' &&
      ((parts[3] === 'document' && parts.length === 4) ||
        (parts[3] === 'units' && parts.length === 5))
    ) {
      await pinResponseFile(ctx, entry.record.fileId, res)
      const session = await ensureSession(entry, req, ctx)
      if (parts[3] === 'document') {
        sendJson(res, 200, {
          model: session.model,
          fonts: session.fonts,
          ...(session.model.format === 'pptx'
            ? { layout: await session.layoutInfo() }
            : { styles: await session.styleContext() }),
        })
      } else {
        const unitId = decodeURIComponent(parts[4])
        const unit =
          session.model.format === 'pptx'
            ? await session.layoutModel(unitId)
            : refreshDocxResourceUrls(
                await session.unit(unitId),
                entry.record.fileId,
                baseUrlOf(req, ctx),
                ctx.token,
              )
        sendJson(res, 200, unit)
      }
      return
    }
    await handleSession(req, res, ctx, url, id, requestId)
    return
  }
  const current = ctx.pendingViews.get(id)
  if (!current) throw new HttpError(404, 'not_found', 'session was closed')
  if (!current.error && !ctx.closing) void startAsyncWork(ctx, current)
  if (req.method === 'GET' && root) {
    sendJson(res, 200, pendingBody(ctx, current))
    return
  }
  throw new HttpError(409, 'session_not_ready', 'wait for the session to become ready')
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
  if (req.method !== 'DELETE') {
    await pinResponseFile(ctx, entry.record.fileId, res)
    if (ctx.sessions.get(sessionId) !== entry)
      throw new HttpError(404, 'not_found', 'session was closed')
  }
  const segments = url.pathname.split('/').filter(Boolean)
  const rest = segments.slice(3)
  if (req.method === 'DELETE' && rest.length === 0) {
    await ctx.pendingViews.remove(sessionId)
    closeSession(entry.session, ctx)
    ctx.sessions.delete(sessionId)
    await ctx.sessionStore.remove(sessionId)
    await removeChunks(chunkDir(ctx.chunkRoot, sessionId))
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET' && rest.length === 0) {
    touchEntry(entry, ctx)
    sendJson(res, 200, {
      sessionId,
      state: 'ready',
      model: entry.record.model,
      fonts: entry.record.fonts,
    })
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
  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'styles') {
    const session = await ensureSession(entry, req, ctx)
    if (session.model.format !== 'docx') {
      sendError(res, 404, 'not_found', 'styles are only available for DOCX', false, requestId)
      return
    }
    sendJson(res, 200, await session.styleContext())
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
  if (req.method === 'GET' && rest.length === 1 && rest[0] === 'layout') {
    const session = await ensureSession(entry, req, ctx)
    if (session.model.format !== 'pptx') {
      sendError(res, 404, 'not_found', 'layout is only available for PPTX', false, requestId)
      return
    }
    sendJson(res, 200, await session.layoutInfo())
    return
  }
  if (req.method === 'GET' && rest.length === 3 && rest[0] === 'layout' && rest[1] === 'slides') {
    try {
      const session = await ensureSession(entry, req, ctx)
      if (session.model.format !== 'pptx') {
        sendError(res, 404, 'not_found', 'layout is only available for PPTX', false, requestId)
        return
      }
      sendJson(res, 200, await session.layoutModel(decodeURIComponent(rest[2])))
    } catch (error) {
      if (error instanceof HttpError) throw error
      const code = (error as { code?: string })?.code
      if (
        code === 'parse_queue_full' ||
        code === 'parse_memory_limit' ||
        code === 'parse_memory_monitor_failed' ||
        code === 'parse_memory_budget' ||
        code === 'artifact_corrupt'
      )
        throw parseFailure(error)
      if (code === 'parse_timeout') {
        throw new HttpError(504, 'parse_timeout', 'slide layout timed out')
      }
      throw new HttpError(
        404,
        'not_found',
        error instanceof Error ? error.message : 'unknown slide',
      )
    }
    return
  }
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'units') {
    try {
      const session = await ensureSession(entry, req, ctx)
      const unit = await session.unit(decodeURIComponent(rest[1]))
      // Sign at response time: persisted DOCX chunks never contain expiring credentials.
      const payload =
        session.model.format === 'docx'
          ? refreshDocxResourceUrls(unit, entry.record.fileId, baseUrlOf(req, ctx), ctx.token)
          : unit
      res.setHeader('Cache-Control', 'private, no-store')
      sendJson(res, 200, payload)
    } catch (error) {
      if (error instanceof HttpError) throw error
      const code = (error as { code?: string })?.code
      if (
        code === 'parse_queue_full' ||
        code === 'parse_memory_limit' ||
        code === 'parse_memory_monitor_failed' ||
        code === 'parse_memory_budget' ||
        code === 'artifact_corrupt'
      )
        throw parseFailure(error)
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

async function pinResponseFile(ctx: Context, fileId: string, res: ServerResponse): Promise<void> {
  const release = await ctx.files.acquire(fileId)
  res.once('finish', release)
  res.once('close', release)
  if (res.destroyed || res.writableFinished) release()
}

async function fileInUse(ctx: Context, fileId: string): Promise<boolean> {
  return (
    ctx.files.has(fileId) ||
    ctx.artifacts.activeFileIds.has(fileId) ||
    [...ctx.sessions.values()].some((entry) => entry.record.fileId === fileId) ||
    ctx.pendingViews.values().some((entry) => entry.fileId === fileId) ||
    (await ctx.library.hasFile(fileId)) ||
    (!!ctx.artifactCatalog && await ctx.artifactCatalog.hasFileReference(fileId))
  )
}

async function reclaimArtifacts(ctx: Context, bytes: number): Promise<void> {
  if (bytes <= 0 || ctx.closing) return
  let freed = 0
  for (const candidate of await ctx.artifacts.evictionCandidates(
    `${ctx.parserVersion}:${ctx.parserFingerprint}`,
  )) {
    if (freed >= bytes || ctx.closing) break
    await ctx.files.withFile(candidate.fileId, async () => {
      if (
        ctx.closing ||
        ctx.files.has(candidate.fileId) ||
        ctx.artifacts.activeFileIds.has(candidate.fileId) ||
        [...ctx.sessions.values()].some((entry) => entry.record.fileId === candidate.fileId) ||
        ctx.pendingViews.values().some((entry) => entry.fileId === candidate.fileId)
      )
        return
      // A cache is expendable only while its source still exists.
      if (!(await ctx.store.pathOf(candidate.fileId))) return
      if (ctx.closing) return
      freed += await ctx.artifacts.evict(candidate.key)
    })
  }
}

function runGc(
  ctx: Context,
  keepFileId?: string,
  committedReservationBytes = 0,
): Promise<void> {
  if (ctx.closing) return Promise.resolve()
  const work = Promise.resolve().then(() => {
    if (!ctx.closing) return performGc(ctx, keepFileId, committedReservationBytes)
  })
  ctx.gcFlights.add(work)
  void work.finally(() => ctx.gcFlights.delete(work)).catch(() => undefined)
  return work
}

async function performGc(ctx: Context, keepFileId?: string, committedReservationBytes = 0): Promise<void> {
  const files = (await ctx.store.list()).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )
  const now = Date.now()
  for (const file of files) {
    if (ctx.closing) return
    if (file.fileId === keepFileId) continue
    await ctx.files.withFile(file.fileId, async () => {
      if (ctx.closing) return
      if (await fileInUse(ctx, file.fileId)) return
      if (ctx.closing) return
      if (now - Date.parse(file.createdAt) <= ctx.contentTtlMs) return
      await ctx.artifacts.removeForFile(file.fileId)
      await ctx.store.remove(file.fileId)
    })
  }
  if (ctx.closing) return
  if (ctx.maxStoreBytes > 0) {
    await reclaimArtifacts(
      ctx,
      ctx.storageBudget.pressureTarget(
        (await ctx.store.totalBytes()) +
          (await ctx.artifacts.totalBytes()) +
          ctx.storageBudget.reservedBytes -
          committedReservationBytes,
      ),
    )
    for (const file of files) {
      if (ctx.closing) return
      if ((await ctx.store.totalBytes()) + (await ctx.artifacts.totalBytes()) <= ctx.maxStoreBytes)
        break
      if (file.fileId === keepFileId) continue
      await ctx.files.withFile(file.fileId, async () => {
        if (ctx.closing) return
        if (await fileInUse(ctx, file.fileId)) return
        if (ctx.closing) return
        if (!(await ctx.store.stat(file.fileId))) return
        if (ctx.closing) return
        await ctx.artifacts.removeForFile(file.fileId)
        await ctx.store.remove(file.fileId)
      })
    }
  }
  if (ctx.closing) return
  await ctx.store.cleanupTemp(60 * 60_000)
  if (ctx.closing) return
  await ctx.artifacts.cleanupStaging(60 * 60_000)
  if (ctx.closing) return
  await collectOrphanChunks(
    ctx.chunkRoot,
    new Set([
      ...ctx.sessionStore.values().map((record) => record.id),
      ...ctx.pendingViews.values().map((record) => record.id),
      ...ctx.pendingSessionIds,
    ]),
    Math.min(ctx.contentTtlMs, 60 * 60_000),
  )
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
  let upload: Awaited<ReturnType<ContentStore['writeTemp']>> | undefined
  let reply: (() => void) | undefined
  const reservation = ctx.storageBudget.reservation({ temporary: true })
  try {
    try {
      upload = await ctx.store.writeTemp(req, ctx.limits.maxUploadBytes, reservation.reserve)
    } catch (error) {
      if (error instanceof UploadTooLargeError) {
        reply = () => sendError(res, 413, 'upload_too_large', error.message)
        return
      }
      if (['storage_full', 'ENOSPC', 'EDQUOT'].includes((error as { code?: string }).code ?? '')) {
        reply = () => sendError(res, 507, 'storage_full', 'insufficient space for upload')
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
      reply = () =>
        sendError(
          res,
          415,
          'unsupported_format',
          `unsupported document format${detected ? ` (${detected})` : ''}; only pptx, pdf and docx are parsed`,
        )
      return
    }
    const completed = upload
    await ctx.files.withFile('storage-admission', async () => {
      const release = await ctx.files.acquire(completed.sha256)
      try {
        const existing = await ctx.store.stat(completed.sha256)
        const stored = await ctx.store.commit(completed, detected)
        ctx.metrics.uploads++
        ctx.metrics.bytesUploaded += stored.size
        await runGc(ctx, stored.fileId, reservation.bytes)
        const total =
          (await ctx.store.totalBytes()) +
          (await ctx.artifacts.totalBytes()) +
          (ctx.storageBudget.reservedBytes - reservation.bytes)
        if (ctx.maxStoreBytes > 0 && total > ctx.maxStoreBytes) {
          release()
          if (!existing)
            await ctx.files.withFile(stored.fileId, async () => {
              if (!(await fileInUse(ctx, stored.fileId))) {
                await ctx.artifacts.removeForFile(stored.fileId)
                await ctx.store.remove(stored.fileId)
              }
            })
          throw new HttpError(
            507,
            'storage_full',
            'content and artifact storage is over its configured quota',
          )
        }
        reply = () => sendJson(res, 201, stored)
      } finally {
        release()
      }
    })
  } finally {
    try {
      if (upload) await ctx.store.abort(upload)
    } finally {
      await reservation.release()
    }
    reply?.()
  }
}

async function handleLibrary(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  url: URL,
): Promise<void> {
  res.setHeader('Cache-Control', 'private, no-store')
  if (url.pathname === '/v2/library' && req.method === 'POST') {
    const body = (await readJsonBody(req, 8 * 1024)) as {
      fileId?: unknown
      displayName?: unknown
    } | null
    if (
      !body ||
      Array.isArray(body) ||
      typeof body.fileId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.fileId) ||
      (body.displayName !== undefined &&
        (typeof body.displayName !== 'string' ||
          !body.displayName.trim() ||
          body.displayName.length > 255))
    ) {
      throw new HttpError(
        400,
        'invalid_request',
        'fileId and an optional nonempty displayName (up to 255 characters) are required',
      )
    }
    const fileId = body.fileId
    const name =
      typeof body.displayName === 'string' ? body.displayName.trim() : fileId.slice(0, 12)
    const entry = await ctx.files.withFile(fileId, async () => {
      if (!(await ctx.store.pathOf(fileId)))
        throw new HttpError(404, 'not_found', 'file content is missing')
      return ctx.library.save(fileId, name)
    })
    sendJson(res, 201, entry)
    return
  }
  if (url.pathname === '/v2/library' && req.method === 'GET') {
    const rawLimit = url.searchParams.get('limit') ?? '50'
    if (!/^[0-9]+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200)
      throw new HttpError(400, 'invalid_request', 'limit must be between 1 and 200')
    const limit = Number(rawLimit)
    const cursor = url.searchParams.get('cursor')
    let after: { createdAt: number; id: string } | undefined
    if (cursor) {
      if (cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cursor))
        throw new HttpError(400, 'invalid_request', 'invalid library cursor')
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
      const match = /^([0-9]{1,16}):([a-f0-9-]{36})$/.exec(decoded)
      if (!match || !Number.isSafeInteger(Number(match[1])))
        throw new HttpError(400, 'invalid_request', 'invalid library cursor')
      after = { createdAt: Number(match[1]), id: match[2] }
    }
    const { items, hasMore } = await ctx.library.page(limit, after)
    const last = items.at(-1)
    const next =
      hasMore && last
        ? Buffer.from(`${last.createdAt}:${last.id}`).toString('base64url')
        : undefined
    sendJson(res, 200, { items, ...(next ? { next } : {}) })
    return
  }
  const match = /^\/v2\/library\/([a-f0-9-]{36})$/.exec(url.pathname)
  if (match && req.method === 'DELETE') {
    if (!(await ctx.library.remove(match[1])))
      throw new HttpError(404, 'not_found', 'library entry not found')
    res.writeHead(204)
    res.end()
    return
  }
  throw new HttpError(404, 'not_found', 'unknown library route')
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
    (req.method === 'GET' &&
      (url.pathname === '/v1/capabilities' || url.pathname === '/v2/capabilities')) ||
    (req.method === 'GET' && url.pathname === '/metrics')
  if (!isPublic && ctx.token) {
    // <img>/<video>/PDF.js cannot send Authorization: content and part URLs
    // carry an HMAC signature instead of the bearer token.
    let signed = false
    if (
      req.headers.authorization !== `Bearer ${ctx.token}` &&
      (segments[0] === 'v1' || segments[0] === 'v2') &&
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
      sessions: ctx.sessions.size + ctx.pendingViews.values().length,
      workers: ctx.parseQueue.snapshot.running,
      reservedParseMb: ctx.parseQueue.memorySnapshot.reservedMb,
      totalParseMb: ctx.parseQueue.memorySnapshot.totalMb,
      queuedParseJobs: ctx.parseQueue.snapshot.queued,
      childProcessRssBytes: isolatedMemory(ctx.processGroup).rssBytes,
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
      sessions: ctx.sessions.size + ctx.pendingViews.values().length,
      pendingSessions: ctx.pendingViews.values().length,
      activeWorkers: ctx.parseQueue.snapshot.running,
      requests: ctx.metrics.requests,
      errors: ctx.metrics.errors,
      uploads: ctx.metrics.uploads,
      bytesUploaded: ctx.metrics.bytesUploaded,
      sessionsCreated: ctx.metrics.sessionsCreated,
      artifacts: {
        ...ctx.artifacts.stats,
        activeBuilds: ctx.artifacts.activeBuilds,
        reservedBytes: ctx.storageBudget.reservedBytes,
      },
      parseQueue: ctx.parseQueue.snapshot,
      parseMemory: ctx.parseQueue.memorySnapshot,
      storageBudget: ctx.storageBudget.snapshot,
      maintenance: { gcTasks: ctx.gcFlights.size, generationCollection: ctx.generationCollection?.snapshot },
      childProcesses: isolatedMemory(ctx.processGroup),
      processLimits: {
        rssMb: ctx.workerRssMb,
        heapMb: ctx.workerMemoryMb,
        sampleMs: ctx.rssSampleMs,
        enforcement: ctx.cgroupRoot ? 'cgroup-v2-and-watchdog' : 'sampled-rss-watchdog',
      },
      parseTimeouts: ctx.metrics.parseTimeouts,
      parseMemoryLimitErrors: ctx.metrics.errorsByCode.get('parse_memory_limit') ?? 0,
      tooManySessions: ctx.metrics.tooManySessions,
      storageBytes: await ctx.store.totalBytes(),
      storage: ctx.db ? 'mysql' : 'filesystem',
      ...(ctx.db ? { mysql: await ctx.db.ping() } : {}),
      memory: { rss: memory.rss, heapUsed: memory.heapUsed },
    })
    return
  }
  if (
    req.method === 'GET' &&
    (url.pathname === '/v1/capabilities' || url.pathname === '/v2/capabilities')
  ) {
    sendJson(res, 200, capabilitiesOf(ctx))
    return
  }
  if (url.pathname === '/v2/library' || url.pathname.startsWith('/v2/library/')) {
    await handleLibrary(req, res, ctx, url)
    return
  }
  if (req.method === 'POST' && url.pathname === '/v2/sessions') {
    await handleCreateAsyncSession(req, res, ctx)
    return
  }
  if (segments[0] === 'v2' && segments[1] === 'sessions' && segments[2]) {
    await handleAsyncSession(req, res, ctx, url, decodeURIComponent(segments[2]), requestId)
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
  if (req.method === 'POST' && (url.pathname === '/v1/files' || url.pathname === '/v2/files')) {
    await handleUpload(req, res, ctx)
    return
  }
  if ((segments[0] !== 'v1' && segments[0] !== 'v2') || segments[1] !== 'files' || !segments[2]) {
    sendError(res, 404, 'not_found', 'unknown route', false, requestId)
    return
  }
  const fileId = decodeURIComponent(segments[2])
  if (req.method === 'GET' || req.method === 'HEAD') {
    await pinResponseFile(ctx, fileId, res)
  }
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
    await ctx.files.withFile(fileId, async () => {
      if (await fileInUse(ctx, fileId)) {
        sendError(
          res,
          409,
          'file_in_use',
          'file is saved or referenced by parsed documents, tasks, or readers',
          false,
          requestId,
        )
        return
      }
      await ctx.artifacts.removeForFile(fileId)
      await ctx.store.remove(fileId)
      res.writeHead(204)
      res.end()
    })
    return
  }
  sendError(res, 404, 'not_found', 'unknown route', false, requestId)
}

export async function createParseServer(options: ParseServerOptions): Promise<ParseServer> {
  if (options.artifactBackend !== undefined && !['local', 'catalog'].includes(options.artifactBackend))
    throw new Error('invalid artifact backend')
  if (options.artifactBackend === 'catalog' && !options.mysql)
    throw new Error('catalog artifact backend requires MySQL')
  validateRuntimeOptions(options)
  const limits = resolveLimits(options.limits)
  const db = options.mysql ? new MysqlDatabase(options.mysql) : undefined
  const store = new ContentStore(options.dataDir, db)
  await store.init()
  const library = new LibraryStore(options.dataDir, db)
  await library.init()
  const sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000
  const sessionStore = new SessionStore(options.dataDir, db)
  await sessionStore.init(sessionTtlMs)
  const pendingViews = new PendingSessionStore(options.dataDir, db)
  await pendingViews.init(sessionTtlMs)
  const files = new FileLifecycle()
  const storageBudget: StorageBudget = new StorageBudget(
    options.maxStoreBytes ?? 20 * 1024 ** 3,
    async () => (await store.totalBytes()) + (await artifacts.totalBytes()),
    (work) => files.withFile('storage-admission', work),
    async () => {
      const info = await statfs(options.dataDir)
      return Math.max(0, info.bavail * info.bsize - 64 * 1024 ** 2)
    },
    (bytes) => reclaimArtifacts(ctx, bytes),
    {
      highPercent: options.storageHighWaterPercent ?? 90,
      lowPercent: options.storageLowWaterPercent ?? 80,
    },
  )
  const artifacts: ArtifactStore = new ArtifactStore(options.dataDir, undefined, storageBudget)
  // Only aged, recognizable temporary paths are eligible. Journal ownership
  // protects restart recovery before any resumed job is allowed to run.
  await store.cleanupTemp(60 * 60_000)
  await artifacts.cleanupStaging(60 * 60_000)
  await collectOrphanChunks(
    join(options.dataDir, 'chunks'),
    new Set([
      ...sessionStore.values().map((record) => record.id),
      ...pendingViews.values().map((record) => record.id),
    ]),
    60 * 60_000,
  )

  const ctx: Context = {
    store,
    artifacts,
    gcFlights: new Set(),
    sessionDisposals: new Set(),
    sessionDisposalByHandle: new WeakMap(),
    storageBudget,
    library,
    files,
    parseQueue: new ParseQueue(
      options.maxParseJobs ?? 2,
      options.maxQueuedParseJobs ?? 20,
      options.parseMemoryMb ?? 8192,
      options.workerRssMb ?? 4096,
    ),
    parserFingerprint:
      options.parserFingerprint ?? (await parserFingerprint(options.parserVersion ?? '0.1.0')),
    sessionStore,
    pendingViews,
    asyncFlights: new Map(),
    metrics: createMetrics(),
    limits,
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
    workerRssMb: options.workerRssMb ?? 4096,
    rssSampleMs: options.rssSampleMs ?? 250,
    cgroupRoot: options.cgroupRoot,
    workerLifetimeMs: options.workerLifetimeMs ?? 600_000,
    processGroup: randomUUID(),
    maxSessions: options.maxSessions ?? 500,
    pendingSessions: 0,
    pendingSessionIds: new Set(),
    closing: false,
    contentTtlMs: options.contentTtlMs ?? 7 * 24 * 60 * 60_000,
    maxStoreBytes: options.maxStoreBytes ?? 20 * 1024 ** 3,
    gcIntervalMs: options.gcIntervalMs ?? 10 * 60_000,
    chunkRoot: join(options.dataDir, 'chunks'),
    ...(db ? { db, artifactCatalog: new MysqlArtifactCatalog(db) } : {}),
  }
  if (ctx.artifactCatalog) {
    if (options.artifactBackend === 'catalog') {
      const disk = new ArtifactGenerations(options.dataDir, undefined, storageBudget)
      ctx.sharedArtifacts = { catalog: ctx.artifactCatalog, disk,
        coordinator: new ArtifactCoordinator(ctx.artifactCatalog, disk) }
    }
    ctx.generationCollection = new ArtifactCollectionService(new ArtifactGenerationSweeper(
      new ArtifactGenerations(options.dataDir, undefined, storageBudget), ctx.artifactCatalog,
    ), { intervalMs: ctx.gcIntervalMs })
  }
  for (const record of sessionStore.values()) ctx.sessions.set(record.id, { record })
  const server: Server = createServer((req, res) => {
    const requestId = requestIdOf(req)
    if (ctx.closing) {
      sendError(res, 503, 'server_stopping', 'server is stopping', true, requestId)
      return
    }
    route(req, res, ctx, requestId).catch((raw: unknown) => {
      // Damage in an already-open view is retryable even on routes without a
      // local parse-failure mapper (styles, fonts, bundle resources).
      const error = raw instanceof ArtifactCorruptionError ? parseFailure(raw) : raw
      if (error instanceof HttpError) {
        if (error.code === 'parse_queue_full') res.setHeader('Retry-After', '5')
        if (error.code === 'artifact_corrupt') res.setHeader('Retry-After', '1')
        if (error.code === 'parse_timeout') ctx.metrics.parseTimeouts++
        if (error.code === 'too_many_sessions') ctx.metrics.tooManySessions++
        recordError(ctx.metrics, error.code)
        logEvent(error.status >= 500 ? 'error' : 'warn', 'request_error', {
          requestId,
          code: error.code,
          status: error.status,
          message: error.message,
        })
        sendError(res, error.status, error.code, error.message,
          error.code === 'artifact_corrupt', requestId)
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
  for (const pending of ctx.pendingViews.values()) {
    if (ctx.sessions.has(pending.id)) await ctx.pendingViews.remove(pending.id)
    else if (!pending.error) void startAsyncWork(ctx, pending)
  }
  ctx.generationCollection?.start()
  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const pending of ctx.pendingViews.values()) {
      if (now - pending.lastUsed > ctx.sessionTtlMs)
        void ctx.pendingViews
          .remove(pending.id)
          .catch((error: unknown) =>
            logEvent('warn', 'pending_session_cleanup_failed', { message: String(error) }),
          )
    }
    for (const [id, entry] of ctx.sessions) {
      if (now - entry.record.lastUsed <= ctx.sessionTtlMs) continue
      closeSession(entry.session, ctx)
      ctx.sessions.delete(id)
      void ctx.sessionStore.remove(id)
      void removeChunks(chunkDir(ctx.chunkRoot, id))
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
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => closing ??= (async () => {
    ctx.closing = true
    clearInterval(sweeper)
    clearInterval(gcTimer)
    const collectionClosed = ctx.generationCollection?.close()
    const coordinatorClosed = ctx.sharedArtifacts?.coordinator.close()
    for (const entry of ctx.sessions.values()) closeSession(entry.session, ctx)
    await ctx.parseQueue.close()
    await coordinatorClosed
    await ctx.artifacts.drain()
    await Promise.allSettled([...ctx.asyncFlights.values()])
    for (const entry of ctx.sessions.values()) closeSession(entry.session, ctx)
    ctx.sessions.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
    await Promise.allSettled([...ctx.gcFlights, ...(collectionClosed ? [collectionClosed] : [])])
    while (ctx.sessionDisposals.size) await Promise.allSettled([...ctx.sessionDisposals])
    await ctx.sessionStore.flush()
    await ctx.library.flush()
    await ctx.pendingViews.flush()
    await db?.close()
  })()
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    store,
    gc: () => {
      if (!ctx.closing) ctx.generationCollection?.request()
      return runGc(ctx)
    },
    close,
    ...(db ? { db } : {}),
  }
}
