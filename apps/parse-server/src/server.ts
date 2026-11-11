import { ArtifactCoordinator } from './artifact-coordinator'
import { ArtifactReadHandle } from './artifact-read-handle'
import { StorageBudget } from './storage-budget'
import { SqlStorageReservations } from './storage-reservations'
import { SqlPressureLedger } from './storage-pressure'
import { stat, statfs } from 'node:fs/promises'
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
import { reconcileOrphanGenerations, type GenerationReconcileResult } from './generation-reconcile'
import { ArtifactCollectionService } from './artifact-collection-service'
import { ArtifactReadyEviction } from './artifact-ready-eviction'
import { PreviewRegistry } from './artifact-preview'
import { parserFingerprint } from './parser-fingerprint'
import { refreshDocxResourceUrls } from './resource-urls'
import { createHash, randomUUID } from 'node:crypto'
import { effectiveRolloutPercent } from './rollout'
import { layoutCacheKey } from './layout-key'
import { CanaryGuard } from './canary-guard'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
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
import type { PptxFontSummary } from './pptx'
import { SessionStore, type SessionRecord } from './session-store'
import {
  createMetrics,
  logEvent,
  recordBundleFailure,
  recordError,
  recordGcBytes,
  recordRequest,
  recordSignatureRefresh,
  recordSweeperBytes,
  recordUnitRead,
  renderPrometheus,
  type ServerMetrics,
} from './telemetry'
import { ContentStore, UploadTooLargeError, type StoredFile } from './storage'
import { MysqlDatabase, type MysqlConfig } from './mysql'
import {
  CACHE_DEFAULTS,
  cacheKeyPrefix,
  type CacheMode,
  type HotCache,
  type HotCacheStore,
  type RedisCacheConfig,
} from './cache-contract'
import { createHotCache } from './hot-cache'
import { createRedisCacheStore } from './redis-cache-client'
import { PARSE_DTO_VERSION } from '@genoffice/parse-contract'
import { IdempotencyStore, readIdempotencyKey } from './idempotency'
import { SharedIdempotencyStore } from './shared-idempotency'
import { normalizeLayoutPrefs } from './layout-prefs'
import { verifyRestore, type BackupManifest, type RestoreReport } from './backup-manifest'
import { MEMORY_CACHE_BUDGET_DEFAULT_BYTES, MODEL_CACHE_DEFAULT_BYTES, ModelCache } from './model-cache'
import { WORK_POOL_DEFAULTS, WorkPools } from './work-pools'
import { MediaService } from './media-service'
import { handleMedia } from './media-http'
import { resolveMediaOptions, type MediaOptions } from './media-options'

export interface ParseServerOptions {
  /** Independent persistent media queue; enabled deployments require MySQL and FFmpeg. */
  media?: MediaOptions
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
  /** Accepted only during token rotation; new requests should use `token`. */
  previousToken?: string
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
  /** Byte budget for the in-memory model read cache; 0 disables it (plan §6.1). */
  modelCacheMaxBytes?: number
  /** Aggregate HTTP/index/read cache target; the model cache is carved out of it. */
  memoryCacheBudgetBytes?: number
  /** Concurrent HTTP handler cap; health and metrics stay reachable when full. */
  httpMaxConcurrency?: number
  /** Concurrent artifact-read disk I/O operations (plan §6.1). */
  diskIoConcurrency?: number
  /** Concurrent artifact decompression operations (plan §6.1). */
  inflateConcurrency?: number
  /** Bounded retries for transient infrastructure build failures (plan §6). */
  buildRetryAttempts?: number
  maxParseJobs?: number
  maxQueuedParseJobs?: number
  /** Delete unreferenced content older than this. */
  contentTtlMs?: number
  /** Soft cap for the content store; new uploads over it get 507. */
  maxStoreBytes?: number
  storageHighWaterPercent?: number
  storageLowWaterPercent?: number
  /**
   * `shared` fences in-flight writes through SQL so multiple instances cannot
   * oversell the same quota. Defaults to shared for the catalog backend and to
   * instance-local accounting otherwise; `shared` requires MySQL.
   */
  storageAdmission?: 'instance' | 'shared'
  /** Lease for a shared reservation; crashed writers are reclaimed after it expires. */
  storageReservationLeaseMs?: number
  /** How often to sweep unreferenced content/temp files. */
  gcIntervalMs?: number
  /** Generation directories kept per artifact key before high-water archiving. */
  generationRetainCount?: number
  /** Only ready generations idle for this long may be withdrawn under pressure. */
  readyEvictionIdleMs?: number
  /** Maximum ready generations examined per pressure pass. */
  readyEvictionBatchSize?: number
  /** Lifetime of one fleet-wide pressure round; a new round starts after expiry. */
  pressureRoundMs?: number
  /** Shorter expiry applied once a shared pressure round is satisfied. */
  pressureCooldownMs?: number
  /** First-frame preview units retained per in-flight build (in-process only). */
  previewMaxUnits?: number
  /** Retention for a completed preview snapshot; failed builds are dropped at once. */
  previewTtlMs?: number
  /**
   * Optional cross-node hot cache (plan §5.1). `memory` keeps the in-process
   * preview only; `redis` mirrors preview frames and build progress and still
   * never carries ready pointers, leases or quotas.
   */
  cacheMode?: CacheMode
  /** Redis connection for `cacheMode: 'redis'`; ignored in memory mode. */
  redis?: RedisCacheConfig
  /** One command budget on the request path (plan §5.1: 50–100 ms). */
  cacheCommandTimeoutMs?: number
  /** Consecutive failures open the breaker for this long before a half-open probe. */
  cacheBreakerMs?: number
  /** TTL of the build-progress projection. */
  cacheProgressTtlMs?: number
  /** Process-wide progress write throttle. */
  cacheProgressThrottleMs?: number
  /** A single preview field above this size is not cached. */
  cacheMaxFieldBytes?: number
  /** Tests/embeddings may inject a store instead of opening Redis. */
  cacheStore?: HotCacheStore
  /**
   * Staged-rollback switch (plan §10): when false the v2 async session routes
   * answer 404 so clients use the v1 synchronous contract again.
   */
  asyncSessionsV2?: boolean
  /**
   * Deterministic per-file v2 canary (plan §10 gray switch): 0 disables the v2
   * session route, 100 serves every file, values in between bucket by fileId.
   */
  v2RolloutPercent?: number
  /** Optional request header used as the canary bucket (tenant/user id). */
  v2RolloutHeader?: string
  /** Time-based auto ramp: percentage points added per hour of uptime. */
  v2RolloutRampPerHour?: number
  /** 0–100 server-error rate that auto-pauses the v2 route; 0 disables. */
  v2AutoPauseErrorRate?: number
  /** Staged/opt-in: materialize document.json/units/fonts next to each generation. */
  canonicalArtifactExport?: boolean
  /** Hard cap for each shutdown phase (plan §6.3); defaults 30 s. */
  shutdownTimeoutMs?: number
  /** Advertised client routing thresholds (plan §8.1); defaults 32/64/64 MiB. */
  docxAutoRemoteBytes?: number
  pptxAutoRemoteBytes?: number
  docxFullRenderBytes?: number
  /** Retention of a v2 POST response keyed by Idempotency-Key (in-process). */
  idempotencyTtlMs?: number
  /** Bounded number of remembered idempotent v2 responses. */
  idempotencyMaxEntries?: number
  /** MySQL persistence for file metadata and sessions; unset = filesystem only. */
  mysql?: MysqlConfig
  /**
   * Recovery drill gate. Before listening, prove a backup manifest's source
   * bytes, catalog rows and every ready pointer. Lost sources/history abort
   * startup; unverifiable ready generations are withdrawn for rebuild.
   */
  restoreCheck?: { manifest: BackupManifest; deep?: boolean; invalidate?: boolean }
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

interface StoredSessionDocument {
  model: DocModel
  fonts: PptxFontSummary[]
}

interface SessionEntry {
  record: SessionRecord
  session?: SessionHandle
  opening?: Promise<SessionHandle>
  /** Artifact document lazily read for v1/v2 responses; never persisted per session. */
  document?: StoredSessionDocument
  documentOpening?: Promise<StoredSessionDocument>
}

interface Context {
  media?: MediaService
  dataDir: string
  store: ContentStore
  artifacts: ArtifactStore
  gcFlights: Set<Promise<void>>
  sessionDisposals: Set<Promise<void>>
  sessionDisposalByHandle: WeakMap<SessionHandle, Promise<void>>
  artifactCatalog?: MysqlArtifactCatalog
  sharedArtifacts?: { catalog: MysqlArtifactCatalog; disk: ArtifactGenerations; coordinator: ArtifactCoordinator }
  generationCollection?: ArtifactCollectionService
  readyEviction?: ArtifactReadyEviction
  previews: PreviewRegistry
  cache: HotCache
  asyncSessionsV2: boolean
  v2RolloutPercent: number
  v2RolloutHeader?: string
  v2RolloutRampPerHour: number
  canaryGuard: CanaryGuard
  canonicalArtifactExport: boolean
  shutdownTimeoutMs: number
  parseThresholds: {
    docxAutoRemoteBytes: number
    pptxAutoRemoteBytes: number
    docxFullRenderBytes: number
  }
  idempotency: IdempotencyStore
  idempotencyTtlMs: number
  sharedIdempotency?: SharedIdempotencyStore
  storageBudget: StorageBudget
  sharedAdmission?: SqlStorageReservations
  sharedPressure?: SqlPressureLedger
  library: LibraryStore
  files: FileLifecycle
  parseQueue: ParseQueue
  parserFingerprint: string
  sessionStore: SessionStore
  pendingViews: PendingSessionStore
  /** Durable reader identity for last-waiter cancellation. */
  readerId: string
  asyncFlights: Map<string, Promise<void>>
  /** Demand signal per async preview; aborted only when the last waiter leaves. */
  asyncAborts: Map<string, { artifactKey: string; controller: AbortController }>
  metrics: ServerMetrics
  modelCache?: ModelCache
  workPools: WorkPools
  memoryCacheBudgetBytes: number
  httpInFlight: number
  httpMaxConcurrency: number
  httpRejected: number
  limits: ServerLimits
  parserVersion: string
  fontSetHash: string
  token?: string
  previousToken?: string
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
  restoreReport?: RestoreReport
  startupReconcile?: GenerationReconcileResult
  startupLeaseRecovery?: { examined: number; requeued: number }
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
    dtoVersion: PARSE_DTO_VERSION,
    parserVersion: ctx.parserVersion,
    formats: ['pptx', 'pdf', 'docx'],
    stages: {
      pptx: ['index', 'model', 'layout'],
      pdf: [],
      docx: ['index', 'model'],
    },
    maxBytes: ctx.limits.maxUploadBytes,
    fontSetHash: ctx.fontSetHash,
    thresholds: ctx.parseThresholds,
    features: {
      mediaTranscoding: ctx.media?.options.enabled === true,
      mediaPreparationIntegrity: ctx.media?.options.enabled === true,
      lazyAssets: true,
      rangeRequests: true,
      fontWidthFeedback: true,
      streamingUnits: true,
      asyncSessions: ctx.asyncSessionsV2,
      historyLibrary: true,
      offlineBundles: true,
      incrementalPreview: true,
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
  entry.record.expiresAt = entry.record.lastUsed + ctx.sessionTtlMs
  void ctx.sessionStore.set(entry.record).catch((error: unknown) =>
    logEvent('warn', 'session_touch_failed', {
      message: error instanceof Error ? error.message : String(error),
    }),
  )
}

/** Record one unit/model read; layout work is measured separately by the renderer. */
async function measuredUnitRead<T>(ctx: Context, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    recordUnitRead(ctx.metrics, (performance.now() - started) / 1000)
  }
}

/** Sign DOCX resource descriptions at response time and count the refresh. */
function signedDocxPayload(
  ctx: Context,
  value: unknown,
  fileId: string,
  baseUrl: string,
): unknown {
  const payload = refreshDocxResourceUrls(value, fileId, baseUrl, ctx.token)
  if (ctx.token) recordSignatureRefresh(ctx.metrics)
  return payload
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
  if (code === 'storage_admission_lease_lost')
    return new HttpError(503, code, 'shared storage admission lease expired; retry')
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
  const [store, input, queue, onAdmission, demand] = args
  return ctx.sharedArtifacts
    ? ArtifactSession.openShared(store, input, ctx.sharedArtifacts, queue, onAdmission, demand)
    : ArtifactSession.open(store, input, queue, onAdmission, demand)
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
  const format = entry.record.format ?? entry.record.model?.format
  if (format !== 'pptx' && format !== 'docx')
    throw new HttpError(409, 'session_expired', 'session record has no artifact identity')
  const baseUrl = baseUrlOf(req, ctx)
  try {
    entry.session = await openDocument(ctx,
      ctx.artifacts,
      {
        id: entry.record.id,
        fileId: entry.record.fileId,
        path,
        width: entry.record.width,
        format,
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
  // New records reference the artifact: no full model/fonts/baseUrl copy is
  // written back. Only the identity and the transient document cache are kept.
  entry.record.format = entry.session.model.format === 'pptx' ||
    entry.session.model.format === 'docx'
    ? entry.session.model.format
    : format
  entry.record.artifactKey ??= artifactKey(
    ArtifactSession.identity({
      fileId: entry.record.fileId,
      format: entry.record.format,
      parserVersion: ctx.parserVersion,
      parserFingerprint: ctx.parserFingerprint,
    }),
  )
  entry.record.parserVersion = ctx.parserVersion
  entry.document = { model: entry.session.model, fonts: entry.session.fonts }
  touchEntry(entry, ctx)
  return entry.session
}

/**
 * Read the shared artifact document (model+fonts) without opening a parser
 * worker. New session records store only the artifact identity; v1 keeps
 * returning model/fonts by reading the published document JSON, falling back to
 * a real reopen (and rebuild) only when the artifact is missing or damaged.
 */
async function sessionDocument(
  entry: SessionEntry,
  req: IncomingMessage,
  ctx: Context,
): Promise<StoredSessionDocument> {
  const document = await storedSessionDocument(entry, req, ctx)
  return document.model.docx
    ? { ...document, model: { ...document.model, docx: { ...document.model.docx,
        hfParts: signedDocxPayload(ctx, document.model.docx.hfParts, entry.record.fileId, baseUrlOf(req, ctx)) as Record<string, object>,
      } } }
    : document
}

async function storedSessionDocument(
  entry: SessionEntry,
  req: IncomingMessage,
  ctx: Context,
): Promise<StoredSessionDocument> {
  if (entry.document) return entry.document
  const record = entry.record
  if (record.model && Array.isArray(record.fonts)) {
    // Legacy row written before the staged migration: one read, then cached.
    entry.document = { model: record.model, fonts: record.fonts }
    return entry.document
  }
  if (entry.documentOpening) return entry.documentOpening
  const load = (async (): Promise<StoredSessionDocument> => {
    const format = record.format
    if (format !== 'pptx' && format !== 'docx')
      throw new HttpError(409, 'session_expired', 'session record has no artifact identity')
    const key = record.artifactKey ?? artifactKey(
      ArtifactSession.identity({
        fileId: record.fileId,
        format,
        parserVersion: ctx.parserVersion,
        parserFingerprint: ctx.parserFingerprint,
      }),
    )
    let raw: Awaited<ReturnType<ArtifactReadHandle['read']>> | undefined
    if (ctx.sharedArtifacts) {
      const handle = await ArtifactReadHandle.open(
        ctx.sharedArtifacts.catalog,
        ctx.sharedArtifacts.disk,
        key,
        `session-document:${randomUUID()}`,
      )
      if (handle) {
        try {
          if (!handle.has('document'))
            throw new ArtifactCorruptionError('artifact document record missing')
          raw = await handle.read('document')
        } finally {
          await handle.close()
        }
      }
    } else {
      const reader = await ctx.artifacts.find(key)
      if (reader) {
        if (!reader.has('document'))
          throw new ArtifactCorruptionError('artifact document record missing')
        raw = await reader.read('document')
      }
    }
    const document = raw && !Buffer.isBuffer(raw)
      ? (raw as { model?: DocModel; fonts?: PptxFontSummary[] })
      : undefined
    if (document?.model && Array.isArray(document.fonts)) {
      const documentFormat = document.model.format
      if (documentFormat === 'pptx' || documentFormat === 'docx') {
        record.format = documentFormat
        record.artifactKey = key
        entry.document = { model: document.model, fonts: document.fonts }
        return entry.document
      }
    }
    // Artifact unavailable: reopen from source, which rebuilds the shared artifact.
    const session = await ensureSession(entry, req, ctx)
    entry.document = { model: session.model, fonts: session.fonts }
    return entry.document
  })()
  entry.documentOpening = load
  try {
    return await load
  } finally {
    if (entry.documentOpening === load) entry.documentOpening = undefined
  }
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
    const createdAt = Date.now()
    const format = session.model.format
    const record: SessionRecord = {
      id: sessionId,
      fileId,
      width,
      parserVersion: ctx.parserVersion,
      format: format as SessionRecord['format'],
      createdAt,
      lastUsed: createdAt,
      // Staged migration (plan §5): the shared artifact identity and idle
      // deadline become columns; the full model/fonts copy stays for v1.
      ...(format === 'pptx' || format === 'docx'
        ? {
            artifactKey: artifactKey(
              ArtifactSession.identity({
                fileId,
                format,
                parserVersion: ctx.parserVersion,
                parserFingerprint: ctx.parserFingerprint,
              }),
            ),
            expiresAt: createdAt + ctx.sessionTtlMs,
          }
        : {}),
    }
    ctx.sessions.set(sessionId, { record, session })
    await ctx.sessionStore.set(record)
    await materializeCanonicalLayout(ctx, session)
    sendJson(res, 201, { sessionId, state: 'ready', model: session.model, fonts: session.fonts })
  } finally {
    release()
  }
}

/**
 * Local preview first; when the shared cache is enabled, resolve the catalog's
 * current build job and read its cross-node projection. A missing or failed
 * projection is "unknown", never evidence of readiness (plan §5.1).
 */
async function sharedPreview(ctx: Context, record: PendingSession) {
  if (record.error) return undefined
  const local = await ctx.cache.lookup(record.artifactKey, record.jobId)
  if (local || !ctx.cache.enabled) return local
  const jobId = await sharedBuildJob(ctx, record)
  return jobId ? ctx.cache.lookup(record.artifactKey, jobId) : undefined
}

/** The catalog's in-flight job id, used only to address the shared projection. */
async function sharedBuildJob(ctx: Context, record: PendingSession): Promise<string | undefined> {
  const catalog = ctx.sharedArtifacts?.catalog
  if (!catalog) return undefined
  try { return (await catalog.activeJob(record.artifactKey)) ?? undefined } catch { return undefined }
}

/**
 * Progress projection. The SQL `parse_jobs.progress` column is only 0/100 (100
 * means ready), so there is no positive SQL value to merge during a build; the
 * projection is the only source of intermediate progress, and a missing
 * projection means "unknown", never ready.
 */
async function sharedProgress(ctx: Context, record: PendingSession) {
  if (record.error || !ctx.cache.enabled) return undefined
  const jobId = await sharedBuildJob(ctx, record)
  return jobId ? ctx.cache.readProgress(jobId) : undefined
}

function layoutKeyOf(ctx: Context, record: { artifactKey?: string; width: number }): string | undefined {
  if (!record.artifactKey) return undefined
  try {
    return layoutCacheKey({
      artifactKey: record.artifactKey, width: record.width, fontSetHash: ctx.fontSetHash,
    })
  } catch {
    return undefined
  }
}

async function materializeCanonicalLayout(
  ctx: Context,
  session: SessionHandle | undefined,
): Promise<void> {
  if (!ctx.canonicalArtifactExport || !session) return
  const reservation = ctx.storageBudget.reservation()
  try {
    const result = await session.materializeCanonical(ctx.dataDir, reservation.reserve)
    logEvent('info', 'canonical_artifact_exported', {
      units: result.units, fonts: result.fonts, documentBytes: result.documentBytes,
    })
  } catch (error) {
    logEvent('warn', 'canonical_artifact_export_failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    await reservation.release().catch(() => undefined)
  }
}

async function pendingBody(ctx: Context, record: PendingSession) {
  const phase = ctx.artifacts.phase(record.artifactKey)
  if (phase === 'building') ctx.pendingViews.observeBuilding(record.id)
  // `state` deliberately stays queued/building: previewable is a capability of
  // an in-flight job, never an alternative to the full-manifest `ready` state.
  const preview = await sharedPreview(ctx, record)
  const progress = preview?.previewable
    ? { unitsProduced: preview.unitsProduced, unitCount: preview.unitCount }
    : await sharedProgress(ctx, record)
  return {
    sessionId: record.id,
    jobId: record.jobId,
    dtoVersion: PARSE_DTO_VERSION,
    artifactKey: record.artifactKey,
    state: record.error ? 'failed' : record.state === 'building' ? 'building' : phase,
    ...(record.layoutPrefs ? { layoutPrefs: record.layoutPrefs } : {}),
    pollAfterMs: 500,
    ...(record.error ? { error: record.error } : {}),
    ...(progress
      ? {
          ...(preview?.previewable
            ? { previewable: true, complete: false, availableUnits: { from: 0, to: preview.cachedUntil } }
            : {}),
          progress: {
            unitsProduced: progress.unitsProduced,
            unitCount: progress.unitCount,
            percent: Math.min(
              99,
              Math.floor((100 * progress.unitsProduced) / Math.max(1, progress.unitCount)),
            ),
          },
        }
      : {}),
  }
}

/** Bound one shutdown phase; a stuck SQL/IO await must not hang the process. */
async function shutdownDeadline(
  work: Promise<unknown>,
  phase: string,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      work.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logEvent('warn', 'shutdown_phase_timeout', { phase, timeoutMs })
          resolve()
        }, timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
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
    const demand = new AbortController()
    ctx.asyncAborts.set(record.id, { artifactKey: record.artifactKey, controller: demand })
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
        demand.signal,
      )
      await materializeCanonicalLayout(ctx, session)
      try {
        if (ctx.closing) return
        if (await ctx.pendingViews.readerCount(record.id) === 0) {
          // Every waiting view went away while the build ran: discard instead of
          // publishing bytes nobody can read.
          await ctx.pendingViews.remove(record.id)
          return
        }
        const now = Date.now()
        const ready: SessionRecord = {
          id: record.id,
          fileId: record.fileId,
          width: record.width,
          parserVersion: ctx.parserVersion,
          format: record.format,
          ...(record.layoutPrefs ? { layoutPrefs: record.layoutPrefs } : {}),
          createdAt: record.createdAt,
          lastUsed: now,
          artifactKey: artifactKey(
            ArtifactSession.identity({
              fileId: record.fileId,
              format: record.format,
              parserVersion: ctx.parserVersion,
              parserFingerprint: ctx.parserFingerprint,
            }),
          ),
          expiresAt: now + ctx.sessionTtlMs,
        }
        await ctx.sessionStore.set(ready)
        if (await ctx.pendingViews.readerCount(record.id) === 0) {
          await ctx.sessionStore.remove(record.id)
          return
        }
        ctx.sessions.set(record.id, {
          record: ready,
          document: { model: session.model, fonts: session.fonts },
        })
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
      if (ctx.asyncAborts.get(record.id)?.controller === demand) ctx.asyncAborts.delete(record.id)
      release?.()
      ctx.pendingSessionIds.delete(record.id)
    }
  })()
    .catch((error: unknown) =>
      logEvent('error', 'async_session_state_failed', {
        sessionId: record.id,
        jobId: record.jobId,
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
  const pending = ctx.pendingViews.get(id)
  if (pending) {
    const remaining = await ctx.pendingViews.removeReader(id, ctx.readerId)
    if (remaining > 0) ctx.pendingViews.forget(id)
    else {
      await ctx.pendingViews.remove(id)
      cancelPendingBuild(ctx, id, pending.artifactKey)
    }
  }
  const ready = ctx.sessions.get(id)
  if (ready) {
    closeSession(ready.session, ctx)
    ctx.sessions.delete(id)
    await ctx.sessionStore.remove(id)
  }
}

/**
 * Plan §6: a temporary preview with no waiters left may cancel the shared build
 * only while it is still queued; a running build keeps its worker and memory
 * reservation until it settles (the queue owns that cleanup).
 */
export function cancelPendingBuild(
  ctx: {
    asyncAborts: Map<string, { artifactKey: string; controller: AbortController }>
    pendingViews: { values(): Iterable<{ id: string; artifactKey: string }> }
  },
  id: string,
  artifactKey: string,
): void {
  // Plan §6: never cancel a shared build another pending viewer still waits on.
  for (const pending of ctx.pendingViews.values())
    if (pending.id !== id && pending.artifactKey === artifactKey) return
  // The shared build may be owned by any of the same-artifact async flights, so
  // abort every controller for this artifact rather than only this session's.
  for (const entry of ctx.asyncAborts.values()) {
    if (entry.artifactKey === artifactKey && !entry.controller.signal.aborted)
      entry.controller.abort(new DOMException('no waiters for pending preview', 'AbortError'))
  }
}

/**
 * Replay an `Idempotency-Key`-tagged create without opening a second waiter.
 * The stored mapping is only the created session identity; the current ready or
 * pending state is recomputed so a retry never replays a stale 202 forever.
 */
async function replayIdempotentSession(
  ctx: Context,
  req: IncomingMessage,
  res: ServerResponse,
  cached: { body: unknown },
): Promise<void> {
  const mapped = cached.body as { sessionId?: unknown; jobId?: unknown } | null
  const sessionId = typeof mapped?.sessionId === 'string' ? mapped.sessionId : undefined
  if (!sessionId)
    throw new HttpError(409, 'idempotency_mismatch', 'stored idempotent response is unusable')
  let ready = ctx.sessions.get(sessionId)
  if (!ready && ctx.db) {
    // The key may have been created by another instance: attach its ready view
    // before deciding this is a closed session.
    await attachReadySession(ctx, sessionId)
    ready = ctx.sessions.get(sessionId)
  }
  if (ready) {
    const document = await sessionDocument(ready, req, ctx)
    sendJson(res, 201, {
      dtoVersion: PARSE_DTO_VERSION,
      sessionId,
      jobId: mapped?.jobId,
      state: 'ready',
      model: document.model,
      fonts: document.fonts,
    })
    return
  }
  let pending = ctx.pendingViews.get(sessionId)
  if (!pending && ctx.db)
    pending = await ctx.pendingViews.load(sessionId).catch(() => undefined)
  if (pending?.error) {
    await ctx.pendingViews.remove(sessionId)
    throw new HttpError(pending.error.status, pending.error.code, pending.error.message)
  }
  if (!pending) throw new HttpError(404, 'not_found', 'session was closed')
  res.setHeader('Location', `/v2/sessions/${sessionId}`)
  res.setHeader('Retry-After', '1')
  sendJson(res, 202, await pendingBody(ctx, pending))
}

async function handleCreateAsyncSession(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
): Promise<void> {
  let idempotencyKey: string | undefined
  try {
    idempotencyKey = readIdempotencyKey(
      req.headers as { 'idempotency-key'?: string | string[] },
    )
  } catch {
    throw new HttpError(400, 'invalid_request', 'invalid Idempotency-Key')
  }
  const idempotencyScope = 'v2:sessions'
  if (idempotencyKey) {
    const cached = ctx.idempotency.get(idempotencyScope, idempotencyKey)
    if (cached) {
      await replayIdempotentSession(ctx, req, res, cached)
      return
    }
    if (ctx.sharedIdempotency) {
      const shared = await ctx.sharedIdempotency.lookup(idempotencyScope, idempotencyKey)
        .catch(() => undefined)
      if (shared?.body) {
        const entry = { status: 202, body: shared.body, headers: {} }
        ctx.idempotency.remember(idempotencyScope, idempotencyKey, entry)
        await replayIdempotentSession(ctx, req, res, entry)
        return
      }
      if (shared?.pending) {
        // Another instance is creating the same key: merge instead of opening a
        // second waiter. Give it a bounded window, then fall through.
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 25))
          const again = await ctx.sharedIdempotency.lookup(idempotencyScope, idempotencyKey)
            .catch(() => undefined)
          if (again?.body) {
            const entry = { status: 202, body: again.body, headers: {} }
            ctx.idempotency.remember(idempotencyScope, idempotencyKey, entry)
            await replayIdempotentSession(ctx, req, res, entry)
            return
          }
          if (!again) break
        }
      }
    }
  }
  const body = (await readJsonBody(req, 64 * 1024)) as {
    fileId?: unknown; width?: unknown; layoutPrefs?: unknown
  } | null
  if (
    !body ||
    Array.isArray(body) ||
    typeof body.fileId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.fileId)
  ) {
    throw new HttpError(400, 'invalid_request', 'fileId is required')
  }
  const fileId = body.fileId
  // Deterministic per-file canary: same file always lands in the same bucket,
  // so a rollout never flips mid-read. 404 makes clients fall back to v1.
  const rolloutPercent = effectiveRolloutPercent(
    ctx.v2RolloutPercent,
    ctx.v2RolloutRampPerHour,
    Date.now() - ctx.metrics.startedAt,
  )
  if (rolloutPercent < 100) {
    const rawHeader = ctx.v2RolloutHeader
      ? req.headers[ctx.v2RolloutHeader]
      : undefined
    const tenant = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
    const bucket = ctx.v2RolloutHeader && typeof tenant === 'string' && tenant.length > 0 &&
      tenant.length <= 128
      ? Number.parseInt(createHash('sha256').update(tenant).digest('hex').slice(0, 4), 16) % 100
      : Number.parseInt(fileId.slice(0, 4), 16) % 100
    if (bucket >= rolloutPercent)
      throw new HttpError(404, 'not_found', 'v2 sessions are not enabled for this file')
  }
  let layoutPrefs: ReturnType<typeof normalizeLayoutPrefs>
  try {
    layoutPrefs = normalizeLayoutPrefs(body.layoutPrefs)
  } catch {
    throw new HttpError(400, 'invalid_request', 'invalid layoutPrefs')
  }
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
    let sharedClaim = false
    try {
      // Bind the waiter to the catalog's in-flight build when one exists so the
      // v2 jobId and the shared progress projection describe the same attempt.
      const sharedJobId = ctx.sharedArtifacts
        ? await ctx.sharedArtifacts.catalog.activeJob(key).catch(() => null)
        : null
      if (idempotencyKey && ctx.sharedIdempotency) {
        sharedClaim = await ctx.sharedIdempotency
          .claim(idempotencyScope, idempotencyKey, ctx.idempotencyTtlMs)
          .catch(() => false)
        if (!sharedClaim) {
          // Another instance owns this key. Wait for its response and replay it
          // instead of opening a competing waiter.
          let completed: { body?: unknown } | undefined
          for (let attempt = 0; attempt < 120; attempt++) {
            const existing = await ctx.sharedIdempotency
              .lookup(idempotencyScope, idempotencyKey).catch(() => undefined)
            if (existing?.body) { completed = existing; break }
            if (!existing) break
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          if (completed?.body) {
            release()
            const entry = { status: 202, body: completed.body, headers: {} }
            ctx.idempotency.remember(idempotencyScope, idempotencyKey, entry)
            await replayIdempotentSession(ctx, req, res, entry)
            return
          }
        }
      }
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
          ...(layoutPrefs ? { layoutPrefs } : {}),
        }, sharedJobId ?? undefined)
      } catch (error) {
        if (sharedClaim && idempotencyKey && ctx.sharedIdempotency)
          await ctx.sharedIdempotency.release(idempotencyScope, idempotencyKey)
            .catch(() => undefined)
        throw error
      }
    } finally {
      ctx.pendingSessions--
    }
    await ctx.pendingViews.registerReader(record.id, ctx.readerId)
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
    if (idempotencyKey) {
      // Remember the created session immediately: a retry during the build says
      // "202, same sessionId" instead of opening a second durable waiter.
      const payload = { sessionId: record.id, jobId: record.jobId }
      ctx.idempotency.remember(idempotencyScope, idempotencyKey, {
        status: 202,
        body: payload,
        headers: {},
      })
      if (ctx.sharedIdempotency) {
        if (sharedClaim) {
          await ctx.sharedIdempotency
            .complete(idempotencyScope, idempotencyKey, payload)
            .catch(() => undefined)
        } else {
          await ctx.sharedIdempotency
            .remember(idempotencyScope, idempotencyKey, payload, ctx.idempotencyTtlMs)
            .catch(() => undefined)
        }
      }
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
      const document = await sessionDocument(ready, req, ctx)
      ctx.metrics.sessionsCreated++
      sendJson(res, 201, {
        dtoVersion: PARSE_DTO_VERSION,
        sessionId: record.id,
        jobId: record.jobId,
        state: 'ready',
        ...(layoutKeyOf(ctx, record) ? { layoutKey: layoutKeyOf(ctx, record) } : {}),
        model: document.model,
        fonts: document.fonts,
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
    sendJson(res, 202, await pendingBody(ctx, pending))
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

/**
 * Cross-instance ready attach (plan §5): a durable ready session created by
 * another instance can be served read-only here once its artifact row is ready.
 * Nothing is rebuilt and no build lease is touched.
 */
async function attachReadySession(ctx: Context, id: string): Promise<void> {
  if (!ctx.db || ctx.sessions.has(id) || !ctx.artifactCatalog) return
  const record = await ctx.sessionStore.load(id).catch(() => undefined)
  if (!record) return
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) return
  // Only attach when this instance can actually see the ready generation. With
  // a shared dataDir the bytes are present; without one the session stays a
  // 404 here rather than a half-working 503.
  if (record.artifactKey) {
    const ready = await ctx.artifactCatalog.getReady(record.artifactKey).catch(() => null)
    if (!ready) return
    try {
      await stat(join(ctx.dataDir, ready.storagePath, 'manifest.json'))
      await stat(join(ctx.dataDir, ready.storagePath, 'units.bin'))
    } catch {
      return
    }
  }
  ctx.sessions.set(record.id, { record })
}

/**
 * Crash takeover (plan §5): a remote waiter whose shared build lease is gone
 * (builder died, lease expired/released) may be resumed by this instance on the
 * next status poll. Claim fencing still guarantees only one build wins.
 */
async function maybeTakeoverPending(
  ctx: Context,
  id: string,
  record: { artifactKey?: string; parserVersion: string; parserFingerprint: string; error?: unknown },
): Promise<void> {
  if (!ctx.sharedArtifacts || ctx.asyncFlights.has(id) || record.error) return
  if (record.parserVersion !== ctx.parserVersion ||
      record.parserFingerprint !== ctx.parserFingerprint) return
  if (!record.artifactKey) return
  const active = await ctx.sharedArtifacts.catalog.activeJob(record.artifactKey).catch(() => null)
  if (active) return
  logEvent('warn', 'pending_waiter_takeover', { sessionId: id })
  await startAsyncWork(ctx, record as Parameters<typeof startAsyncWork>[1]).catch(() => undefined)
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
  let pending = ctx.pendingViews.get(id)
  if (!pending && !ctx.sessions.has(id) && ctx.db) {
    // Cross-instance attach: the durable waiter lives in MySQL, so any instance
    // can serve its state. Such a waiter is read-only here: this instance must
    // not start a competing build or delete the builder's row.
    pending = await ctx.pendingViews.load(id).catch(() => undefined)
  }
  if (!pending && !ctx.sessions.has(id) && req.method !== 'DELETE')
    await attachReadySession(ctx, id)
  if (pending && ctx.pendingViews.isRemote(id) &&
      !(await ctx.pendingViews.sharedExists(id).catch(() => true))) {
    // Another instance published/discarded this waiter: drop the stale remote
    // view and fall through to ready attach (or 404).
    ctx.pendingViews.forget(id)
    pending = undefined
    if (req.method !== 'DELETE') await attachReadySession(ctx, id)
  }
  if (pending) await ctx.pendingViews.registerReader(id, ctx.readerId)
  if (pending && req.method === 'GET' && ctx.pendingViews.isRemote(id) && !ctx.sessions.has(id))
    void maybeTakeoverPending(ctx, id, pending)
  // Plan §7: heartbeat renews only the lightweight reading session. It never
  // touches a build lease, a ready pointer or a generation.
  if (req.method === 'POST' && parts.length === 4 && parts[3] === 'heartbeat') {
    const ready = ctx.sessions.get(id)
    if (!ready && !pending) throw new HttpError(404, 'not_found', 'unknown session')
    // Heartbeat is also the incremental reading-position channel (plan §4.1).
    const body = (await readJsonBody(req, 16 * 1024).catch(() => null)) as {
      layoutPrefs?: unknown
    } | null
    let layoutPrefs: ReturnType<typeof normalizeLayoutPrefs>
    try {
      layoutPrefs = normalizeLayoutPrefs(body?.layoutPrefs)
    } catch {
      throw new HttpError(400, 'invalid_request', 'invalid layoutPrefs')
    }
    if (layoutPrefs !== undefined) {
      if (pending) await ctx.pendingViews.setLayoutPrefs(id, layoutPrefs)
      if (ready) ready.record.layoutPrefs = layoutPrefs
    }
    if (pending) await ctx.pendingViews.touch(id)
    if (ready) touchEntry(ready, ctx)
    sendJson(res, 200, {
      dtoVersion: PARSE_DTO_VERSION,
      sessionId: id,
      state: ready ? 'ready' : pending?.error ? 'failed' : pending?.state ?? 'queued',
      pollAfterMs: ready ? 0 : 500,
    })
    return
  }
  if (req.method === 'DELETE' && root) {
    if (!pending && !ctx.sessions.has(id)) throw new HttpError(404, 'not_found', 'unknown session')
    if (pending) {
      // Last-waiter cancellation: keep the shared waiter (and the build) alive
      // while another instance is still reading; drop it when this was the last
      // active reader.
      const remaining = await ctx.pendingViews.removeReader(id, ctx.readerId)
      if (remaining > 0) ctx.pendingViews.forget(id)
      else {
        await ctx.pendingViews.remove(id)
        cancelPendingBuild(ctx, id, pending.artifactKey)
      }
      res.writeHead(204)
      res.end()
      return
    }
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
    if (
      (parts[3] === 'bundle' || parts[3] === 'bundle-manifest') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      // Plan §7 names the route /bundle-manifest; /bundle is the existing path.
      // Both return the same versioned manifest; the alias has no sub-resources.
      if (parts[3] === 'bundle-manifest' && parts.length !== 4)
        throw new HttpError(404, 'not_found', 'unknown bundle route')
      try {
        await handleOfflineBundle(req, res, ctx, entry, parts)
      } catch (error) {
        recordBundleFailure(ctx.metrics)
        throw error
      }
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
          dtoVersion: PARSE_DTO_VERSION,
          model: session.model,
          fonts: session.fonts,
          ...(layoutKeyOf(ctx, entry.record) ? { layoutKey: layoutKeyOf(ctx, entry.record) } : {}),
          ...(session.model.format === 'pptx'
            ? { layout: await session.layoutInfo() }
            : { styles: await session.styleContext() }),
        })
      } else {
        const unitId = decodeURIComponent(parts[4])
        const unit =
          session.model.format === 'pptx'
            ? await measuredUnitRead(ctx, () => session.layoutModel(unitId))
            : signedDocxPayload(
                ctx,
                await measuredUnitRead(ctx, () => session.unit(unitId)),
                entry.record.fileId,
                baseUrlOf(req, ctx),
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
  if (!current.error && !ctx.closing && !ctx.pendingViews.isRemote(id))
    void startAsyncWork(ctx, current)
  if (req.method === 'GET' && root) {
    sendJson(res, 200, await pendingBody(ctx, current))
    return
  }
  // Incremental first frame: only units whose gzip+sha256 frames are already
  // committed to the writer may be read. This never touches a ready generation,
  // never marks anything ready, and never satisfies an offline bundle request.
  const preview = await sharedPreview(ctx, current)
  if (req.method === 'GET' && preview?.previewable) {
    await pinResponseFile(ctx, current.fileId, res)
    if (parts[3] === 'document' && parts.length === 4) {
      sendJson(res, 200, {
        state: 'building',
        model: preview.document.model,
        fonts: preview.document.fonts,
        ...(preview.format === 'pptx'
          ? { layout: preview.document.layout }
          : { styles: preview.styles }),
        complete: false,
        unitsProduced: preview.unitsProduced,
        unitCount: preview.unitCount,
      })
      return
    }
    if (parts[3] === 'units' && parts.length === 4) {
      const rawLimit = Number(url.searchParams.get('limit') ?? 100)
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.trunc(rawLimit))) : 100
      const cursor = url.searchParams.get('cursor')
      const start = cursor === null ? 0 : Number.parseInt(cursor, 10)
      if (!Number.isInteger(start) || start < 0 || start > preview.unitCount)
        throw new HttpError(400, 'invalid_request', 'invalid unit cursor')
      const end = Math.min(preview.cachedUntil, start + limit)
      const items = []
      for (let index = start; index < end; index++)
        items.push({
          id: String(index),
          kind: preview.document.model.unitKind,
          index,
          anchor: String(index),
        })
      sendJson(res, 200, {
        state: 'building',
        items,
        ...(end < preview.cachedUntil ? { next: String(end) } : {}),
        complete: false,
        unitsProduced: preview.unitsProduced,
        unitCount: preview.unitCount,
        availableUnits: { from: 0, to: preview.cachedUntil },
        // `complete: false` is the only offline-completion signal; a building
        // listing must never be mistaken for the final manifest.
        pending: {
          from: Math.max(start, preview.cachedUntil),
          to: preview.unitCount,
          code: 'unit_pending',
          retryAfterMs: 500,
          pollAfterMs: 500,
        },
      })
      return
    }
    if (parts[3] === 'units' && parts.length === 5) {
      const unitId = decodeURIComponent(parts[4])
      const index = /^(0|[1-9]\d*)$/.test(unitId) ? Number(unitId) : -1
      if (!Number.isSafeInteger(index) || index < 0 || index >= preview.unitCount)
        throw new HttpError(400, 'invalid_request', 'invalid unit id')
      if (index >= preview.cachedUntil) {
        res.setHeader('Retry-After', '1')
        sendJson(res, 202, {
          state: 'pending',
          code: 'unit_pending',
          unitId,
          availableUnits: { from: 0, to: preview.cachedUntil },
          unitsProduced: preview.unitsProduced,
          unitCount: preview.unitCount,
          complete: false,
          retryAfterMs: 500,
          pollAfterMs: 500,
        })
        return
      }
      // Canonical records carry no deployment origin or expiring signature.
      sendJson(
        res,
        200,
        signedDocxPayload(ctx, preview.units[index], current.fileId, baseUrlOf(req, ctx)),
      )
      return
    }
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
    // New records store only the artifact identity: read model/fonts from the
    // published document (no parser worker) instead of a per-session SQL copy.
    const document = await sessionDocument(entry, req, ctx)
    const unitCount = document.model.unitCount ?? 0
    // v2 adds the stable artifact identity and a terminal progress projection;
    // v1 keeps its existing body for compatibility.
    const format = document.model.format
    const artifactIdentity =
      url.pathname.startsWith('/v2/') && (format === 'pptx' || format === 'docx')
        ? artifactKey(
            ArtifactSession.identity({
              fileId: entry.record.fileId,
              format,
              parserVersion: ctx.parserVersion,
              parserFingerprint: ctx.parserFingerprint,
            }),
          )
        : undefined
    sendJson(res, 200, {
      dtoVersion: PARSE_DTO_VERSION,
      sessionId,
      state: 'ready',
      model: document.model,
      fonts: document.fonts,
      ...(layoutKeyOf(ctx, entry.record) ? { layoutKey: layoutKeyOf(ctx, entry.record) } : {}),
      ...(artifactIdentity
        ? {
            artifactKey: artifactIdentity,
            expiresAt: entry.record.expiresAt,
            ...(entry.record.layoutPrefs ? { layoutPrefs: entry.record.layoutPrefs } : {}),
            progress: { unitsProduced: unitCount, unitCount, percent: 100 },
            pollAfterMs: 0,
            complete: true,
          }
        : {}),
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
      sessionUnits(
        (await sessionDocument(entry, req, ctx)).model,
        url.searchParams.get('cursor') ?? undefined,
        limit,
      ),
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
      sendJson(
        res,
        200,
        await measuredUnitRead(ctx, () => session.layoutModel(decodeURIComponent(rest[2]))),
      )
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
      const unit = await measuredUnitRead(ctx, () => session.unit(decodeURIComponent(rest[1])))
      // Sign at response time: persisted DOCX chunks never contain expiring credentials.
      const payload =
        session.model.format === 'docx'
          ? signedDocxPayload(ctx, unit, entry.record.fileId, baseUrlOf(req, ctx))
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
    (ctx.media ? (await ctx.media.catalog.protectedFiles()).includes(fileId) : false) ||
    ctx.files.has(fileId) ||
    ctx.artifacts.activeFileIds.has(fileId) ||
    [...ctx.sessions.values()].some((entry) => entry.record.fileId === fileId) ||
    ctx.pendingViews.values().some((entry) => entry.fileId === fileId) ||
    (await ctx.library.hasFile(fileId)) ||
    (!!ctx.artifactCatalog && (await ctx.artifactCatalog.hasFileReference(fileId) ||
      await ctx.artifactCatalog.hasDependencyOnFile(fileId)))
  )
}

async function reclaimArtifacts(ctx: Context, bytes: number): Promise<void> {
  if (ctx.closing) return
  // Capacity pressure accelerates old-generation collection. Only scheduling
  // happens here: the SQL retirement/archive transaction must never run under
  // the shared storage admission GET_LOCK.
  ctx.generationCollection?.request(true)
  // Only a hint: catalog withdraw/retirement transactions run later in the
  // background sweeper, never while this GET_LOCK is held.
  if (bytes > 0) ctx.readyEviction?.request(bytes)
  if (bytes <= 0) return
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
  // Reconcile redundant pre-generation flat bytes with the background collector.
  // The catalog transaction that authorizes deletion must not run under the
  // storage admission lock, so GC only reports the bytes and requests a sweep.
  if (ctx.artifactCatalog) {
    const pending = await ctx.artifacts.legacyFlatEntries()
    ctx.artifacts.stats.legacyFlatPendingBytes = pending.bytes
    if (pending.keys.length) ctx.generationCollection?.request()
  }
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
      recordGcBytes(ctx.metrics, file.size)
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
        recordGcBytes(ctx.metrics, file.size)
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
      if ((error as { code?: string }).code === 'storage_admission_lease_lost') {
        res.setHeader('Retry-After', '1')
        reply = () => sendError(res, 503, 'storage_admission_lease_lost',
          'shared storage admission lease expired; retry', true)
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
    if (detected === 'encrypted') {
      await ctx.store.abort(upload)
      reply = () =>
        sendError(
          res,
          415,
          'encrypted_document',
          'document is password-protected (encrypted Office container); password input and decryption are not supported',
        )
      return
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
  const bearerMatches = (authorization: string | undefined): boolean =>
    authorization === `Bearer ${ctx.token}` ||
    (ctx.previousToken !== undefined && authorization === `Bearer ${ctx.previousToken}`)
  if (!isPublic && ctx.token) {
    // <img>/<video>/PDF.js cannot send Authorization: content and part URLs
    // carry an HMAC signature instead of the bearer token.
    let signed = false
    if (
      !bearerMatches(req.headers.authorization) &&
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
      else if (segments[3] === 'media' && segments.length === 6 && segments[5] === 'content' &&
          (req.method === 'GET' || req.method === 'HEAD')) resource = `media:${segments[4]}`
      if (resource) {
        const exp = Number(url.searchParams.get('exp'))
        const sig = url.searchParams.get('sig') ?? ''
        signed = verifyResource(ctx.token, fileId, resource, exp, sig)
      }
    }
    if (!bearerMatches(req.headers.authorization) && !signed) {
      sendError(res, 401, 'unauthorized', 'a bearer token is required', false, requestId)
      return
    }
  }

  if (req.method === 'GET' && url.pathname === '/metrics') {
    const memory = process.memoryUsage()
    let body = renderPrometheus({
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
      cache: ctx.cache.stats(),
      modelCache: ctx.modelCache?.stats(),
      http: {
        inFlight: ctx.httpInFlight,
        maxConcurrency: ctx.httpMaxConcurrency,
        rejected: ctx.httpRejected,
      },
      pools: ctx.workPools.stats(),
      buildRetries: {
        local: ctx.artifacts.stats.buildRetries,
        shared: ctx.sharedArtifacts?.coordinator.stats.retries ?? 0,
      },
      oldestQueuedMs: ctx.parseQueue.oldestWaitMs,
      artifact: ctx.artifacts.stats,
      storageSourceBytes: await ctx.store.totalBytes(),
      storageArtifactBytes: await ctx.artifacts.totalBytes(),
      storageStagingBytes: await ctx.artifacts.stagingBytes(),
    })
    if (ctx.media) {
      const media = await ctx.media.catalog.snapshot()
      body += '\n# TYPE genoffice_media_jobs gauge\n'
      for (const state of ['queued', 'processing', 'ready', 'failed'])
        body += `genoffice_media_jobs{state="${state}"} ${media.jobs[state] ?? 0}\n`
      body += `genoffice_media_cache_bytes ${media.cacheBytes}\n`
      for (const [name, value] of Object.entries(ctx.media.stats))
        body += `genoffice_media_${name}_total ${value}\n`
    }
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
      media: ctx.media ? { enabled: ctx.media.options.enabled, ...await ctx.media.catalog.snapshot(), counters: ctx.media.stats } : null,
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
      storageBudget: {
        ...ctx.storageBudget.snapshot,
        sharedReservedBytes: await ctx.storageBudget.sharedReservedBytes(),
        coordination: ctx.sharedAdmission ? 'shared' : 'instance',
      },
      maintenance: {
        gcTasks: ctx.gcFlights.size,
        generationCollection: ctx.generationCollection?.snapshot,
        incrementalPreview: ctx.previews.stats(),
        startupReconcile: ctx.startupReconcile ?? null,
        leaseRecovery: ctx.startupLeaseRecovery ?? null,
      },
      cache: ctx.cache.stats(),
      artifactCoordinator: ctx.sharedArtifacts?.coordinator.stats ?? null,
      memoryCache: {
        budgetBytes: ctx.memoryCacheBudgetBytes,
        model: ctx.modelCache?.stats() ?? null,
      },
      http: {
        inFlight: ctx.httpInFlight,
        maxConcurrency: ctx.httpMaxConcurrency,
        rejected: ctx.httpRejected,
      },
      pools: ctx.workPools.stats(),
      idempotency: ctx.idempotency.stats(),
      readyEviction: ctx.readyEviction?.snapshot ?? null,
      canaryGuard: ctx.canaryGuard.snapshot(),
      sharedPressure: (await ctx.sharedPressure?.state()) ?? null,
      restore: ctx.restoreReport ? {
        checkedAt: ctx.restoreReport.checkedAt,
        ok: ctx.restoreReport.ok,
        readyAllowed: ctx.restoreReport.readyAllowed,
        digest: ctx.restoreReport.digest,
        counts: ctx.restoreReport.counts,
        blockedReady: ctx.restoreReport.blockedReady.length,
        errors: ctx.restoreReport.errors.length,
        warnings: ctx.restoreReport.warnings.length,
      } : null,
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
  if (url.pathname === '/v2' || url.pathname.startsWith('/v2/'))
    res.setHeader('X-Genoffice-Dto-Version', String(PARSE_DTO_VERSION))
  if (
    req.method === 'GET' &&
    (url.pathname === '/v1/capabilities' || url.pathname === '/v2/capabilities')
  ) {
    sendJson(res, 200, capabilitiesOf(ctx))
    return
  }
  if (
    !ctx.asyncSessionsV2 &&
    (url.pathname === '/v2/sessions' || url.pathname.startsWith('/v2/sessions/'))
  ) {
    // Staged rollback: behave like a server that predates the v2 contract.
    sendError(res, 404, 'not_found', 'v2 async sessions are disabled', false, requestId)
    return
  }
  if (url.pathname === '/v2/library' || url.pathname.startsWith('/v2/library/')) {
    await handleLibrary(req, res, ctx, url)
    return
  }
  if (req.method === 'POST' && url.pathname === '/v2/sessions') {
    if (ctx.canaryGuard.paused())
      throw new HttpError(404, 'not_found', 'v2 sessions are temporarily paused')
    try {
      await handleCreateAsyncSession(req, res, ctx)
      ctx.canaryGuard.record(true)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      // Only server-side failures trip the emergency brake; 4xx is client input.
      ctx.canaryGuard.record(status < 500)
      throw error
    }
    return
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
  if (segments[3] === 'media') {
    await handleMedia(req, res, { media: ctx.media, fileId, rest: segments.slice(4),
      baseUrl: baseUrlOf(req, ctx), token: ctx.token, readJson: () => readJsonBody(req, 8192) })
    return
  }
  if (segments.length === 4 && segments[3] === 'part-url' && req.method === 'POST') {
    // Refresh one signed part URL (image/audio/font) without reopening a session;
    // used by viewers after a 403/expiry or a deployment-origin change.
    const body = await readJsonBody(req, 8 * 1024) as { path?: unknown } | null
    const path = body?.path
    if (typeof path !== 'string' || path.length < 1 || path.length > 512 || path.startsWith('/') ||
      path.includes('..') || [...path].some((character) => {
        const code = character.charCodeAt(0)
        return code < 0x20 || code === 0x7f
      }))
      throw new HttpError(400, 'invalid_request', 'invalid part path')
    const base = baseUrlOf(req, ctx)
    const plain = `${base}/v1/files/${encodeURIComponent(fileId)}/parts/${path.split('/').map(encodeURIComponent).join('/')}`
    if (!ctx.token) {
      sendJson(res, 200, { url: plain })
      return
    }
    const { exp, sig } = signResource(ctx.token, fileId, path)
    sendJson(res, 200, {
      url: `${plain}?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    })
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
  if (options.storageAdmission === 'shared' && !options.mysql)
    throw new Error('shared storage admission requires MySQL')
  if (options.storageAdmission !== undefined && !['instance', 'shared'].includes(options.storageAdmission))
    throw new Error('invalid storage admission mode')
  validateRuntimeOptions(options)
  let restoreReport: RestoreReport | undefined
  if (options.restoreCheck) {
    // Gate before any listener, queue or GC is started. Use a short-lived pool
    // so a failed drill cannot leak database connections or partially started
    // maintenance work. Source/history loss is fatal; rebuildable generations
    // are withdrawn by compare-and-clear and rebuilt on the next request.
    const gateDb = options.mysql ? new MysqlDatabase(options.mysql) : undefined
    try {
      restoreReport = await verifyRestore({
        dataDir: options.dataDir,
        manifest: options.restoreCheck.manifest,
        db: gateDb,
        deep: options.restoreCheck.deep,
        invalidate: options.restoreCheck.invalidate,
      })
    } finally { await gateDb?.close() }
    if (!restoreReport.ok || !restoreReport.readyAllowed)
      throw new Error(`restore check failed: ${restoreReport.errors.map((issue) => issue.code).join(',') || 'unverified ready pointers'}`)
  }
  const limits = resolveLimits(options.limits)
  const db = options.mysql ? new MysqlDatabase(options.mysql) : undefined
  const store = new ContentStore(options.dataDir, db)
  await store.init()
  const mediaOptions = resolveMediaOptions(options.media)
  if (mediaOptions.enabled && !db) {
    throw new Error('media conversion requires MySQL for durable shared tasks')
  }
  const existingMediaCache = db && (await stat(join(options.dataDir, 'media-cache')).catch(() => null))?.isDirectory()
  const media = (mediaOptions.enabled || existingMediaCache) && db ? new MediaService({
    dataDir: options.dataDir, store, db, limits, options: mediaOptions,
  }) : undefined
  try { await media?.init() }
  catch (error) { await media?.close(); await db?.close(); throw error }
  const sharedAdmission = db && (
    options.storageAdmission === 'shared' ||
    (options.storageAdmission !== 'instance' && options.artifactBackend === 'catalog')
  )
    ? new SqlStorageReservations(db, {
      ...(options.storageReservationLeaseMs === undefined
        ? {} : { leaseMs: options.storageReservationLeaseMs }),
    })
    : undefined
  if (sharedAdmission) {
    await sharedAdmission.init()
    // Startup reconciliation: rows from processes that died without closing are
    // invisible to admission already; remove them so the ledger stays bounded.
    const reclaimed = await sharedAdmission.reconcile()
    if (reclaimed > 0) logEvent('info', 'storage_admission_reconciled', { reclaimed })
  }
  // The pressure ledger needs MySQL but not the admission GET_LOCK: every call
  // happens later in the background sweeper. A fleet of catalog instances then
  // shares one reclaim budget instead of each reclaiming the full deficit.
  const sharedPressure = db ? new SqlPressureLedger(db, {
    ...(options.pressureRoundMs === undefined ? {} : { roundMs: options.pressureRoundMs }),
    ...(options.pressureCooldownMs === undefined ? {} : { cooldownMs: options.pressureCooldownMs }),
  }) : undefined
  if (sharedPressure) await sharedPressure.init()
  const library = new LibraryStore(options.dataDir, db)
  await library.init()
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000
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
    sharedAdmission,
  )
  // Plan §6.1: byte-bounded model read cache, carved out of the aggregate
  // HTTP/index/read-cache budget. 0 disables the cache (and still records stats).
  const memoryCacheBudgetBytes = options.memoryCacheBudgetBytes ?? MEMORY_CACHE_BUDGET_DEFAULT_BYTES
  const modelCacheMaxBytes = Math.min(
    options.modelCacheMaxBytes ?? MODEL_CACHE_DEFAULT_BYTES,
    memoryCacheBudgetBytes,
  )
  const modelCache = modelCacheMaxBytes > 0 ? new ModelCache(modelCacheMaxBytes) : undefined
  // Plan §6.1: bounded disk-I/O and inflate pools so read fan-out cannot
  // materialize unbounded kernel I/O or zlib work in the HTTP process.
  const workPools = new WorkPools({
    diskIoConcurrency: options.diskIoConcurrency ?? WORK_POOL_DEFAULTS.diskIoConcurrency,
    inflateConcurrency: options.inflateConcurrency ?? WORK_POOL_DEFAULTS.inflateConcurrency,
  })
  const artifacts: ArtifactStore = new ArtifactStore(
    options.dataDir, undefined, storageBudget, modelCache, workPools,
    options.buildRetryAttempts ?? 2,
  )
  const previews = new PreviewRegistry({
    maxUnits: options.previewMaxUnits ?? 8,
    ttlMs: options.previewTtlMs ?? 60_000,
  })
  // Shared catalog is created before the context so startup reconcile can run
  // before any listener accepts traffic.
  const artifactCatalog = db ? new MysqlArtifactCatalog(db) : undefined
  // Optional cross-node projection (plan §5.1). Memory keeps exactly the
  // in-process preview; redis mirrors frames/progress and never carries truth.
  const cacheMode: CacheMode = options.cacheMode ?? 'memory'
  const cacheStore = options.cacheStore ?? (cacheMode === 'redis'
    ? createRedisCacheStore(options.redis ?? {}, {
      timeoutMs: options.cacheCommandTimeoutMs ?? CACHE_DEFAULTS.commandTimeoutMs,
      breakerMs: options.cacheBreakerMs ?? CACHE_DEFAULTS.breakerMs,
    })
    : undefined)
  const cache = createHotCache({
    mode: cacheMode,
    ...(cacheStore ? { store: cacheStore } : {}),
    previewRegistry: previews,
    keyPrefix: cacheKeyPrefix(options.mysql?.database ?? 'default'),
    previewMaxUnits: options.previewMaxUnits ?? 8,
    previewTtlMs: options.previewTtlMs ?? CACHE_DEFAULTS.previewTtlMs,
    progressTtlMs: options.cacheProgressTtlMs ?? CACHE_DEFAULTS.progressTtlMs,
    progressThrottleMs: options.cacheProgressThrottleMs ?? CACHE_DEFAULTS.progressThrottleMs,
    maxFieldBytes: options.cacheMaxFieldBytes ?? CACHE_DEFAULTS.maxFieldBytes,
  })
  // Bounded, in-process replay cache for v2 POST retries (plan §7). It is a
  // memory aid, not a shared ledger: a restart or another node re-runs the POST.
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 600_000
  const idempotency = new IdempotencyStore({
    ttlMs: idempotencyTtlMs,
    maxEntries: options.idempotencyMaxEntries ?? 256,
  })
  // Durable cross-instance ledger for Idempotency-Key replay (plan §7).
  const sharedIdempotency = db ? new SharedIdempotencyStore(db, idempotencyTtlMs) : undefined
  // The observer is attached to this parent-process object: session inputs are
  // structured-cloned into the isolated worker and cannot carry a function.
  // `jobId` binds the shared projection to one build attempt.
  artifacts.previewObserver = (key, event, jobId) => cache.report(jobId, key, event)
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
  // Startup reconcile (plan §5): remove "published but unregistered" generation
  // directories. A key with any catalog row is protected, and the age grace keeps
  // a concurrent publish between rename and SQL completion safe.
  const startupReconcile = artifactCatalog
    ? await reconcileOrphanGenerations({
        root: options.dataDir,
        catalog: artifactCatalog,
      }).catch((error: unknown) => {
        logEvent('warn', 'orphan_generation_reconcile_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
        return undefined
      })
    : undefined
  if (startupReconcile?.removedGenerations)
    logEvent('info', 'orphan_generations_reconciled', {
      removed: startupReconcile.removedGenerations,
      retained: startupReconcile.retainedGenerations,
      emptyKeys: startupReconcile.removedEmptyKeys,
      truncated: startupReconcile.truncated,
    })
  // Plan §6: actively requeue builds whose lease expired while no process was
  // running. Claims would reclaim them lazily, but an explicit queued state is
  // what restart recovery, health and operators rely on.
  const startupLeaseRecovery = artifactCatalog
    ? await artifactCatalog.recoverExpiredBuilds().catch((error: unknown) => {
        logEvent('warn', 'lease_recovery_failed', {
          message: error instanceof Error ? error.message : String(error),
        })
        return undefined
      })
    : undefined
  if (startupLeaseRecovery?.requeued)
    logEvent('info', 'expired_build_leases_requeued', {
      examined: startupLeaseRecovery.examined,
      requeued: startupLeaseRecovery.requeued,
    })

  const ctx: Context = {
    media,
    dataDir: options.dataDir,
    store,
    artifacts,
    gcFlights: new Set(),
    sessionDisposals: new Set(),
    sessionDisposalByHandle: new WeakMap(),
    storageBudget,
    previews,
    cache,
    asyncSessionsV2: options.asyncSessionsV2 ?? true,
    v2RolloutPercent: options.v2RolloutPercent ?? 100,
    ...(options.v2RolloutHeader ? { v2RolloutHeader: options.v2RolloutHeader } : {}),
    v2RolloutRampPerHour: options.v2RolloutRampPerHour ?? 0,
    canaryGuard: new CanaryGuard({ errorRatePercent: options.v2AutoPauseErrorRate ?? 0 }),
    canonicalArtifactExport: options.canonicalArtifactExport ?? false,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 30_000,
    parseThresholds: {
      docxAutoRemoteBytes: options.docxAutoRemoteBytes ?? 32 * 1024 * 1024,
      pptxAutoRemoteBytes: options.pptxAutoRemoteBytes ?? 64 * 1024 * 1024,
      docxFullRenderBytes: options.docxFullRenderBytes ?? 64 * 1024 * 1024,
    },
    idempotency,
    idempotencyTtlMs,
    ...(sharedIdempotency ? { sharedIdempotency } : {}),
    ...(sharedAdmission ? { sharedAdmission } : {}),
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
    readerId: randomUUID(),
    asyncFlights: new Map(),
    asyncAborts: new Map(),
    metrics: createMetrics(),
    ...(modelCache ? { modelCache } : {}),
    workPools,
    memoryCacheBudgetBytes,
    httpInFlight: 0,
    httpMaxConcurrency: options.httpMaxConcurrency ?? 128,
    httpRejected: 0,
    limits,
    parserVersion: options.parserVersion ?? '0.1.0',
    fontSetHash: options.fontSetHash ?? 'server-default',
    token: options.token,
    ...(options.previousToken ? { previousToken: options.previousToken } : {}),
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
    ...(db ? { db, ...(artifactCatalog ? { artifactCatalog } : {}) } : {}),
    ...(startupReconcile ? { startupReconcile } : {}),
    ...(startupLeaseRecovery ? { startupLeaseRecovery } : {}),
    ...(sharedPressure ? { sharedPressure } : {}),
    ...(restoreReport ? { restoreReport } : {}),
  }
  if (ctx.artifactCatalog) {
    const disk = new ArtifactGenerations(options.dataDir, undefined, storageBudget, modelCache, workPools)
    const readyEviction = new ArtifactReadyEviction(ctx.artifactCatalog, disk, {
      idleMs: options.readyEvictionIdleMs ?? 60_000,
      batchSize: options.readyEvictionBatchSize ?? 16,
      sourceExists: async (fileId) => !!(await store.pathOf(fileId)),
      ...(ctx.sharedPressure ? { ledger: ctx.sharedPressure } : {}),
      onReclaimed: (result) => {
        if (result.withdrawn > 0) logEvent('info', 'ready_generations_reclaimed',
          { withdrawn: result.withdrawn, collected: result.collected, bytes: result.bytesFreed })
      },
    })
    ctx.readyEviction = readyEviction
    if (options.artifactBackend === 'catalog') {
      ctx.sharedArtifacts = { catalog: ctx.artifactCatalog, disk,
        coordinator: new ArtifactCoordinator(ctx.artifactCatalog, disk, undefined, undefined,
          { attempts: options.buildRetryAttempts ?? 2 }) }
    }
    ctx.generationCollection = new ArtifactCollectionService(new ArtifactGenerationSweeper(
      disk, ctx.artifactCatalog, ctx.artifactCatalog,
      (key, bytes) => {
        artifacts.stats.legacyFlatCollected++
        artifacts.stats.legacyFlatCollectedBytes += bytes
        artifacts.stats.legacyFlatPendingBytes = Math.max(0,
          artifacts.stats.legacyFlatPendingBytes - bytes)
        artifacts.forgetFlat(key)
      },
      {
        retainGenerations: options.generationRetainCount ?? 4,
        archiveCatalog: ctx.artifactCatalog,
        onArchived: (archive) => {
          artifacts.stats.archivedKeys++
          artifacts.stats.archivedRetiredRows += archive.retiredGenerations
        },
        readyEviction,
      },
    ), {
      intervalMs: ctx.gcIntervalMs,
      // Plan §11 gc_deleted_bytes: physical bytes removed by background collection.
      onResult: (result) =>
        recordSweeperBytes(
          ctx.metrics,
          (result.flatBytes ?? 0) + (result.readyBytes ?? 0) + (result.collectedBytes ?? 0),
        ),
    })
  }
  for (const record of sessionStore.values()) ctx.sessions.set(record.id, { record })
  const server: Server = createServer((req, res) => {
    const requestId = requestIdOf(req)
    if (ctx.closing) {
      sendError(res, 503, 'server_stopping', 'server is stopping', true, requestId)
      return
    }
    // Plan §6.1: cap HTTP fan-out so "no parse worker" is not mistaken for a
    // free read. Health and metrics stay reachable while saturated.
    const pathname = (req.url ?? '/').split('?')[0]
    const probe = pathname === '/v1/health' || pathname === '/metrics'
    if (!probe && ctx.httpInFlight >= ctx.httpMaxConcurrency) {
      ctx.httpRejected++
      res.setHeader('Retry-After', '1')
      sendError(res, 503, 'server_busy', 'too many concurrent HTTP requests', true, requestId)
      return
    }
    ctx.httpInFlight++
    res.once('close', () => {
      ctx.httpInFlight--
    })
    route(req, res, ctx, requestId).catch((raw: unknown) => {
      // Damage in an already-open view is retryable even on routes without a
      // local parse-failure mapper (styles, fonts, bundle resources).
      const error = raw instanceof ArtifactCorruptionError ? parseFailure(raw) : raw
      if (error instanceof HttpError) {
        if (error.code === 'parse_queue_full') res.setHeader('Retry-After', '5')
        if (error.code === 'artifact_corrupt' || error.code === 'storage_admission_lease_lost')
          res.setHeader('Retry-After', '1')
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
          error.code === 'artifact_corrupt' || error.code === 'storage_admission_lease_lost', requestId)
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
          .then(() => cancelPendingBuild(ctx, pending.id, pending.artifactKey))
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
    await shutdownDeadline(ctx.media?.close() ?? Promise.resolve(), 'media_queue', ctx.shutdownTimeoutMs)
    clearInterval(sweeper)
    clearInterval(gcTimer)
    ctx.previews.clear()
    ctx.readyEviction?.close()
    const collectionClosed = ctx.generationCollection?.close()
    const coordinatorClosed = ctx.sharedArtifacts?.coordinator.close()
    for (const entry of ctx.sessions.values()) closeSession(entry.session, ctx)
    await shutdownDeadline(ctx.parseQueue.close(), 'parse_queue', ctx.shutdownTimeoutMs)
    await shutdownDeadline(coordinatorClosed ?? Promise.resolve(), 'coordinator', ctx.shutdownTimeoutMs)
    await shutdownDeadline(ctx.artifacts.drain(), 'artifact_drain', ctx.shutdownTimeoutMs)
    await shutdownDeadline(
      Promise.allSettled([...ctx.asyncFlights.values()]), 'async_flights', ctx.shutdownTimeoutMs)
    for (const entry of ctx.sessions.values()) closeSession(entry.session, ctx)
    ctx.sessions.clear()
    server.closeAllConnections?.()
    await shutdownDeadline(new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    }), 'http_close', ctx.shutdownTimeoutMs)
    await shutdownDeadline(
      Promise.allSettled([...ctx.gcFlights, ...(collectionClosed ? [collectionClosed] : [])]),
      'gc_flights', ctx.shutdownTimeoutMs)
    while (ctx.sessionDisposals.size) await Promise.allSettled([...ctx.sessionDisposals])
    // Flush the trailing progress projection and close the shared client before
    // the database goes away; cache teardown only loses projections.
    await ctx.cache.close()
    ctx.idempotency.close()
    await ctx.sessionStore.flush()
    await ctx.library.flush()
    await ctx.pendingViews.flush()
    // Graceful shutdown releases our rows immediately instead of making other
    // instances wait for the lease to expire.
    await sharedAdmission?.close().catch((error: unknown) =>
      logEvent('warn', 'storage_admission_release_failed', { message: String(error) }),
    )
    if (db) await shutdownDeadline(db.close(), 'database', ctx.shutdownTimeoutMs)
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
