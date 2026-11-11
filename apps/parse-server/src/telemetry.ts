import { CACHE_DEFAULTS, type CacheStatsSnapshot } from './cache-contract'
import type { ModelCacheStats } from './model-cache'
import type { PoolStats } from './work-pools'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const
type LogLevel = keyof typeof LEVELS

function configuredLevel(): LogLevel {
  const raw = process.env.PARSE_SERVER_LOG_LEVEL
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

/** One JSON line per event; request paths are logged, bodies/tokens are not. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (process.env.VITEST) return
  if (LEVELS[level] < LEVELS[configuredLevel()]) return
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`,
  )
}

export const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const

/** Unit reads include cache hits and artifact frames; layout work is not included. */
export const UNIT_READ_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5] as const

export interface ServerMetrics {
  startedAt: number
  requests: number
  errors: number
  uploads: number
  bytesUploaded: number
  sessionsCreated: number
  parseTimeouts: number
  tooManySessions: number
  requestsByMethod: Map<string, number>
  requestsByStatus: Map<string, number>
  errorsByCode: Map<string, number>
  durationBuckets: number[]
  durationSum: number
  durationCount: number
  /** Latency of a single unit/model read (plan §11 unit_read_latency). */
  unitReadBuckets: number[]
  unitReadSum: number
  unitReadCount: number
  /** Bytes removed by local content GC; artifact/sweeper bytes are separate counters. */
  gcDeletedBytes: number
  /** Bytes removed by the background generation/staging/flat sweeper. */
  sweeperDeletedBytes: number
  bundleFailures: number
  signatureRefreshes: number
}

export function createMetrics(): ServerMetrics {
  return {
    startedAt: Date.now(),
    requests: 0,
    errors: 0,
    uploads: 0,
    bytesUploaded: 0,
    sessionsCreated: 0,
    parseTimeouts: 0,
    tooManySessions: 0,
    requestsByMethod: new Map(),
    requestsByStatus: new Map(),
    errorsByCode: new Map(),
    durationBuckets: DURATION_BUCKETS.map(() => 0),
    durationSum: 0,
    durationCount: 0,
    unitReadBuckets: UNIT_READ_BUCKETS.map(() => 0),
    unitReadSum: 0,
    unitReadCount: 0,
    gcDeletedBytes: 0,
    sweeperDeletedBytes: 0,
    bundleFailures: 0,
    signatureRefreshes: 0,
  }
}

export function recordRequest(
  metrics: ServerMetrics,
  method: string,
  status: number,
  durationMs: number,
): void {
  metrics.requests++
  if (status >= 500) metrics.errors++
  metrics.requestsByMethod.set(method, (metrics.requestsByMethod.get(method) ?? 0) + 1)
  const statusKey = String(status)
  metrics.requestsByStatus.set(statusKey, (metrics.requestsByStatus.get(statusKey) ?? 0) + 1)
  const seconds = durationMs / 1000
  metrics.durationSum += seconds
  metrics.durationCount++
  for (let index = 0; index < DURATION_BUCKETS.length; index++) {
    if (seconds <= DURATION_BUCKETS[index]) metrics.durationBuckets[index]++
  }
}

export function recordError(metrics: ServerMetrics, code: string): void {
  metrics.errorsByCode.set(code, (metrics.errorsByCode.get(code) ?? 0) + 1)
}

export function recordUnitRead(metrics: ServerMetrics, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return
  metrics.unitReadSum += seconds
  metrics.unitReadCount++
  for (let index = 0; index < UNIT_READ_BUCKETS.length; index++)
    if (seconds <= UNIT_READ_BUCKETS[index]) metrics.unitReadBuckets[index]++
}

export function recordBundleFailure(metrics: ServerMetrics): void {
  metrics.bundleFailures++
}

export function recordSignatureRefresh(metrics: ServerMetrics): void {
  metrics.signatureRefreshes++
}

export function recordSweeperBytes(metrics: ServerMetrics, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return
  metrics.sweeperDeletedBytes += Math.floor(bytes)
}

export function recordGcBytes(metrics: ServerMetrics, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) return
  metrics.gcDeletedBytes += Math.floor(bytes)
}

export interface PrometheusSnapshot {
  metrics: ServerMetrics
  sessions: number
  workers: number
  storageBytes: number
  memory: { rss: number; heapUsed: number }
  parserVersion: string
  reservedParseMb?: number
  totalParseMb?: number
  queuedParseJobs?: number
  childProcessRssBytes?: number
  /** Optional hot cache (plan §5.1). Absent for embeddings/tests that render without one. */
  cache?: CacheStatsSnapshot
  /** Optional byte-bounded model read cache (plan §6.1). */
  modelCache?: ModelCacheStats
  /** HTTP fan-out saturation (plan §6.1). */
  http?: { inFlight: number; maxConcurrency: number; rejected: number }
  /** Bounded disk-I/O and inflate pools (plan §6.1). */
  pools?: { disk: PoolStats; inflate: PoolStats }
  /** Bounded transient-infrastructure build retries (plan §6). */
  buildRetries?: { local: number; shared: number }
  /** Age of the oldest queued build, in milliseconds (plan §11 queue age). */
  oldestQueuedMs?: number
  /** Cumulative artifact store counters (miss/corruption) for the missing metrics. */
  artifact?: { misses: number; corruptions: number; evictedBytes: number;
    legacyFlatCollectedBytes: number }
  /** Storage breakdown (plan §11): source files, published artifacts, staging. */
  storageSourceBytes?: number
  storageArtifactBytes?: number
  storageStagingBytes?: number
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function metric(
  lines: string[],
  name: string,
  type: 'counter' | 'gauge' | 'histogram',
  help: string,
): void {
  lines.push(`# HELP ${name} ${help}`)
  lines.push(`# TYPE ${name} ${type}`)
}

/** Prometheus text exposition (v0.0.4). */
export function renderPrometheus(snapshot: PrometheusSnapshot): string {
  const { metrics } = snapshot
  const lines: string[] = []
  const uptime = Math.max(0, Math.floor((Date.now() - metrics.startedAt) / 1000))

  metric(lines, 'genoffice_parse_build_info', 'gauge', 'Build/parser version information.')
  lines.push(`genoffice_parse_build_info{version="${escapeLabel(snapshot.parserVersion)}"} 1`)

  metric(lines, 'genoffice_parse_requests_total', 'counter', 'HTTP requests by method.')
  for (const [method, count] of [...metrics.requestsByMethod].sort()) {
    for (const [status, statusCount] of [...metrics.requestsByStatus].sort()) {
      // Method/status are independent dimensions; emit the full cross product only
      // for methods that were seen with that status is not tracked, so use totals
      // per dimension below and keep the common combined counter at request level.
      void status
      void statusCount
    }
    lines.push(`genoffice_parse_requests_total{method="${escapeLabel(method)}"} ${count}`)
  }
  metric(lines, 'genoffice_parse_responses_total', 'counter', 'HTTP responses by status code.')
  for (const [status, count] of [...metrics.requestsByStatus].sort()) {
    lines.push(`genoffice_parse_responses_total{status="${escapeLabel(status)}"} ${count}`)
  }

  metric(
    lines,
    'genoffice_parse_request_duration_seconds',
    'histogram',
    'HTTP request duration histogram in seconds.',
  )
  for (let index = 0; index < DURATION_BUCKETS.length; index++) {
    lines.push(
      `genoffice_parse_request_duration_seconds_bucket{le="${DURATION_BUCKETS[index]}"} ${metrics.durationBuckets[index]}`,
    )
  }
  lines.push(`genoffice_parse_request_duration_seconds_bucket{le="+Inf"} ${metrics.durationCount}`)
  lines.push(`genoffice_parse_request_duration_seconds_sum ${metrics.durationSum}`)
  lines.push(`genoffice_parse_request_duration_seconds_count ${metrics.durationCount}`)

  metric(lines, 'genoffice_parse_errors_total', 'counter', 'Request errors by code.')
  for (const [code, count] of [...metrics.errorsByCode].sort()) {
    lines.push(`genoffice_parse_errors_total{code="${escapeLabel(code)}"} ${count}`)
  }

  metric(lines, 'genoffice_parse_uploads_total', 'counter', 'Uploaded files.')
  lines.push(`genoffice_parse_uploads_total ${metrics.uploads}`)
  metric(lines, 'genoffice_parse_upload_bytes_total', 'counter', 'Uploaded bytes.')
  lines.push(`genoffice_parse_upload_bytes_total ${metrics.bytesUploaded}`)
  metric(lines, 'genoffice_parse_sessions_created_total', 'counter', 'Created parse sessions.')
  lines.push(`genoffice_parse_sessions_created_total ${metrics.sessionsCreated}`)
  metric(lines, 'genoffice_parse_timeouts_total', 'counter', 'Parse timeouts.')
  lines.push(`genoffice_parse_timeouts_total ${metrics.parseTimeouts}`)
  metric(lines, 'genoffice_parse_too_many_sessions_total', 'counter', 'Rejected sessions.')
  lines.push(`genoffice_parse_too_many_sessions_total ${metrics.tooManySessions}`)

  metric(lines, 'genoffice_parse_sessions_active', 'gauge', 'Session records currently loaded.')
  lines.push(`genoffice_parse_sessions_active ${snapshot.sessions}`)
  metric(lines, 'genoffice_parse_workers_active', 'gauge', 'Open parse workers.')
  lines.push(`genoffice_parse_workers_active ${snapshot.workers}`)
  metric(
    lines,
    'genoffice_parse_reserved_memory_bytes',
    'gauge',
    'Memory reserved by running parse/layout jobs.',
  )
  lines.push(`genoffice_parse_reserved_memory_bytes ${(snapshot.reservedParseMb ?? 0) * 1024 ** 2}`)
  metric(
    lines,
    'genoffice_parse_memory_budget_bytes',
    'gauge',
    'Configured total parse/layout memory budget.',
  )
  lines.push(`genoffice_parse_memory_budget_bytes ${(snapshot.totalParseMb ?? 0) * 1024 ** 2}`)
  metric(
    lines,
    'genoffice_parse_jobs_queued',
    'gauge',
    'Unique jobs waiting for CPU or memory capacity.',
  )
  lines.push(`genoffice_parse_jobs_queued ${snapshot.queuedParseJobs ?? 0}`)
  metric(
    lines,
    'genoffice_parse_children_resident_memory_bytes',
    'gauge',
    "Latest externally sampled RSS of this server's parser/layout child processes.",
  )
  lines.push(`genoffice_parse_children_resident_memory_bytes ${snapshot.childProcessRssBytes ?? 0}`)
  metric(lines, 'genoffice_parse_storage_bytes', 'gauge', 'Committed content-store bytes.')
  lines.push(`genoffice_parse_storage_bytes ${snapshot.storageBytes}`)
  metric(lines, 'genoffice_parse_storage_source_bytes', 'gauge', 'Original uploaded source bytes.')
  lines.push(`genoffice_parse_storage_source_bytes ${snapshot.storageSourceBytes ?? 0}`)
  metric(lines, 'genoffice_parse_storage_artifact_bytes', 'gauge',
    'Published parse artifact/generation bytes.')
  lines.push(`genoffice_parse_storage_artifact_bytes ${snapshot.storageArtifactBytes ?? 0}`)
  metric(lines, 'genoffice_parse_storage_staging_bytes', 'gauge',
    'Unpublished staging bytes (in-progress builds).')
  lines.push(`genoffice_parse_storage_staging_bytes ${snapshot.storageStagingBytes ?? 0}`)
  metric(lines, 'genoffice_parse_uptime_seconds', 'gauge', 'Process uptime in seconds.')
  lines.push(`genoffice_parse_uptime_seconds ${uptime}`)
  metric(
    lines,
    'genoffice_parse_process_resident_memory_bytes',
    'gauge',
    'Process resident memory.',
  )
  lines.push(`genoffice_parse_process_resident_memory_bytes ${snapshot.memory.rss}`)
  metric(lines, 'genoffice_parse_process_heap_used_bytes', 'gauge', 'V8 heap used.')
  lines.push(`genoffice_parse_process_heap_used_bytes ${snapshot.memory.heapUsed}`)

  metric(
    lines,
    'genoffice_parse_unit_read_latency_seconds',
    'histogram',
    'Latency of one unit/model read (cache or artifact frame; layout excluded).',
  )
  for (let index = 0; index < UNIT_READ_BUCKETS.length; index++) {
    lines.push(
      `genoffice_parse_unit_read_latency_seconds_bucket{le="${UNIT_READ_BUCKETS[index]}"} ${metrics.unitReadBuckets[index]}`,
    )
  }
  lines.push(`genoffice_parse_unit_read_latency_seconds_bucket{le="+Inf"} ${metrics.unitReadCount}`)
  lines.push(`genoffice_parse_unit_read_latency_seconds_sum ${metrics.unitReadSum}`)
  lines.push(`genoffice_parse_unit_read_latency_seconds_count ${metrics.unitReadCount}`)

  metric(
    lines,
    'genoffice_parse_job_queue_age_seconds',
    'gauge',
    'Age of the oldest build waiting for CPU/memory capacity.',
  )
  lines.push(`genoffice_parse_job_queue_age_seconds ${(snapshot.oldestQueuedMs ?? 0) / 1000}`)

  metric(
    lines,
    'genoffice_parse_gc_deleted_bytes_total',
    'counter',
    'Bytes removed by GC: source TTL/eviction, legacy flat archives and background sweeps.',
  )
  const artifact = snapshot.artifact
  const deletedBytes =
    metrics.gcDeletedBytes +
    metrics.sweeperDeletedBytes +
    (artifact?.evictedBytes ?? 0) +
    (artifact?.legacyFlatCollectedBytes ?? 0)
  lines.push(`genoffice_parse_gc_deleted_bytes_total ${deletedBytes}`)

  metric(lines, 'genoffice_parse_bundle_failure_total', 'counter', 'Offline bundle build/resource failures.')
  lines.push(`genoffice_parse_bundle_failure_total ${metrics.bundleFailures}`)
  metric(lines, 'genoffice_parse_signature_refresh_total', 'counter',
    'Resource descriptions re-signed at response time.')
  lines.push(`genoffice_parse_signature_refresh_total ${metrics.signatureRefreshes}`)
  metric(lines, 'genoffice_parse_artifact_miss_total', 'counter',
    'Artifact lookups that found no local/published artifact.')
  lines.push(`genoffice_parse_artifact_miss_total ${artifact?.misses ?? 0}`)
  metric(lines, 'genoffice_parse_artifact_corrupt_total', 'counter',
    'Artifact corruption reports observed by the store.')
  lines.push(`genoffice_parse_artifact_corrupt_total ${artifact?.corruptions ?? 0}`)

  const cache = snapshot.cache
  if (cache) {
    metric(lines, 'genoffice_cache_mode', 'gauge', 'Configured hot-cache mode (1 for the active mode).')
    lines.push(`genoffice_cache_mode{mode="${escapeLabel(cache.mode)}"} 1`)
    metric(lines, 'genoffice_cache_enabled', 'gauge', 'Whether the shared hot cache is enabled.')
    lines.push(`genoffice_cache_enabled ${cache.enabled ? 1 : 0}`)
    metric(lines, 'genoffice_cache_hit_total', 'counter', 'Hot-cache read hits.')
    lines.push(`genoffice_cache_hit_total ${cache.hits}`)
    metric(lines, 'genoffice_cache_miss_total', 'counter', 'Hot-cache read misses.')
    lines.push(`genoffice_cache_miss_total ${cache.misses}`)
    metric(lines, 'genoffice_cache_error_total', 'counter', 'Hot-cache errors (degraded only).')
    lines.push(`genoffice_cache_error_total ${cache.errors}`)
    metric(lines, 'genoffice_cache_timeout_total', 'counter', 'Hot-cache command timeouts.')
    lines.push(`genoffice_cache_timeout_total ${cache.timeouts}`)
    metric(lines, 'genoffice_cache_hit_rate', 'gauge', 'Cache hit ratio over process lifetime.')
    lines.push(`genoffice_cache_hit_rate ${cache.hitRate}`)
    metric(lines, 'genoffice_cache_breaker_open', 'gauge', '1 while the cache circuit breaker is open.')
    lines.push(`genoffice_cache_breaker_open ${cache.breaker === 'open' ? 1 : 0}`)
    metric(
      lines,
      'genoffice_cache_latency_seconds',
      'histogram',
      'Hot-cache read latency histogram in seconds.',
    )
    for (let index = 0; index < CACHE_DEFAULTS.latencyBuckets.length; index++) {
      lines.push(
        `genoffice_cache_latency_seconds_bucket{le="${CACHE_DEFAULTS.latencyBuckets[index]}"} ${cache.latency.buckets[index] ?? 0}`,
      )
    }
    // The last bucket entry is the cumulative +Inf count (see CacheLatency).
    lines.push(
      `genoffice_cache_latency_seconds_bucket{le="+Inf"} ${cache.latency.buckets[CACHE_DEFAULTS.latencyBuckets.length] ?? cache.latency.count}`,
    )
    lines.push(`genoffice_cache_latency_seconds_sum ${cache.latency.sum}`)
    lines.push(`genoffice_cache_latency_seconds_count ${cache.latency.count}`)
    if (cache.lastErrorAt !== null) {
      metric(lines, 'genoffice_cache_last_error_timestamp_seconds', 'gauge',
        'Wall-clock time of the last degraded cache error.')
      lines.push(`genoffice_cache_last_error_timestamp_seconds ${Math.floor(cache.lastErrorAt / 1000)}`)
    }
  }

  const modelCache = snapshot.modelCache
  if (modelCache) {
    metric(lines, 'genoffice_parse_model_cache_bytes', 'gauge',
      'Bytes held by the in-memory model read cache (plan §6.1).')
    lines.push(`genoffice_parse_model_cache_bytes ${modelCache.bytes}`)
    metric(lines, 'genoffice_parse_model_cache_max_bytes', 'gauge',
      'Configured byte budget of the in-memory model read cache.')
    lines.push(`genoffice_parse_model_cache_max_bytes ${modelCache.maxBytes}`)
    metric(lines, 'genoffice_parse_model_cache_entries', 'gauge',
      'Records currently held by the model read cache.')
    lines.push(`genoffice_parse_model_cache_entries ${modelCache.entries}`)
    metric(lines, 'genoffice_parse_model_cache_hits_total', 'counter',
      'Model read-cache hits over process lifetime.')
    lines.push(`genoffice_parse_model_cache_hits_total ${modelCache.hits}`)
    metric(lines, 'genoffice_parse_model_cache_misses_total', 'counter',
      'Model read-cache misses over process lifetime.')
    lines.push(`genoffice_parse_model_cache_misses_total ${modelCache.misses}`)
    metric(lines, 'genoffice_parse_model_cache_evictions_total', 'counter',
      'Records evicted to stay inside the model read-cache byte budget.')
    lines.push(`genoffice_parse_model_cache_evictions_total ${modelCache.evictions}`)
    metric(lines, 'genoffice_parse_model_cache_skipped_total', 'counter',
      'Records too large for the cache budget and therefore not cached.')
    lines.push(`genoffice_parse_model_cache_skipped_total ${modelCache.skipped}`)
  }

  const http = snapshot.http
  if (http) {
    metric(lines, 'genoffice_parse_http_requests_in_flight', 'gauge',
      'HTTP requests currently being handled.')
    lines.push(`genoffice_parse_http_requests_in_flight ${http.inFlight}`)
    metric(lines, 'genoffice_parse_http_concurrency_limit', 'gauge',
      'Configured concurrent HTTP handler cap (plan §6.1).')
    lines.push(`genoffice_parse_http_concurrency_limit ${http.maxConcurrency}`)
    metric(lines, 'genoffice_parse_http_rejected_total', 'counter',
      'Requests rejected with server_busy because the HTTP concurrency cap was reached.')
    lines.push(`genoffice_parse_http_rejected_total ${http.rejected}`)
  }

  const buildRetries = snapshot.buildRetries
  if (buildRetries) {
    metric(lines, 'genoffice_parse_build_retries_total', 'counter',
      'Builds retried after a transient infrastructure failure (plan §6).')
    lines.push(`genoffice_parse_build_retries_total{scope="local"} ${buildRetries.local}`)
    lines.push(`genoffice_parse_build_retries_total{scope="shared"} ${buildRetries.shared}`)
  }

  const pools = snapshot.pools
  if (pools) {
    for (const [pool, stats] of Object.entries(pools)) {
      metric(lines, 'genoffice_parse_work_pool_limit', 'gauge',
        'Configured concurrency limit of a bounded read work pool (plan §6.1).')
      lines.push(`genoffice_parse_work_pool_limit{pool="${escapeLabel(pool)}"} ${stats.limit}`)
      metric(lines, 'genoffice_parse_work_pool_active', 'gauge',
        'Tasks currently executing in a bounded read work pool.')
      lines.push(`genoffice_parse_work_pool_active{pool="${escapeLabel(pool)}"} ${stats.active}`)
      metric(lines, 'genoffice_parse_work_pool_waiting', 'gauge',
        'Tasks queued behind a bounded read work pool limit.')
      lines.push(`genoffice_parse_work_pool_waiting{pool="${escapeLabel(pool)}"} ${stats.waiting}`)
      metric(lines, 'genoffice_parse_work_pool_peak', 'gauge',
        'Highest observed occupancy of a bounded read work pool.')
      lines.push(`genoffice_parse_work_pool_peak{pool="${escapeLabel(pool)}"} ${stats.peak}`)
      metric(lines, 'genoffice_parse_work_pool_peak_waiting', 'gauge',
        'Highest observed queue depth behind a bounded read work pool limit.')
      lines.push(`genoffice_parse_work_pool_peak_waiting{pool="${escapeLabel(pool)}"} ${stats.peakWaiting}`)
    }
  }

  return `${lines.join('\n')}\n`
}
