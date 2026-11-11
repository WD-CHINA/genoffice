import type { BuildPreviewEvent, PreviewSnapshot } from './artifact-preview'

/**
 * Optional hot-cache layer (plan §5.1).
 *
 * Truth never moves here: ready pointers, generations, leases, quotas, pressure
 * ledgers and artifact indexes stay in MySQL and on disk. The cache only carries
 * the preview frames and build-progress projection, and every read is a hint for
 * the "not ready yet" path — a positive `ready` decision always goes through the
 * catalog lease and the ready pointer.
 */

export type CacheMode = 'memory' | 'redis'

/** Redis connection settings; mirrors the optional `mysql` server option. */
export interface RedisCacheConfig {
  host?: string
  port?: number
  /** Unix socket path; takes precedence over host/port (tests and local ops). */
  socketPath?: string
  username?: string
  password?: string
  db?: number
  /** Enable TLS (production requirement, see plan §5.1). */
  tls?: boolean
}

export interface CacheClientStats {
  commands: number
  errors: number
  timeouts: number
  lastErrorAt: number | null
  /** Non-null while the breaker is open (including the half-open probe); null when closed. */
  breakerOpenedAt: number | null
}

/** Raised when the client is unavailable (breaker open, connection lost, timeout). */
export class CacheUnavailableError extends Error {
  readonly code = 'cache_unavailable'
  constructor(message = 'hot cache is unavailable', options?: ErrorOptions) {
    super(message, options)
    this.name = 'CacheUnavailableError'
  }
}

/**
 * Minimal semantic store the hot-cache layer needs. The Redis implementation
 * (`redis-cache-client.ts`) adds RESP, ACL/TLS, timeouts and a circuit breaker;
 * tests may inject an in-memory implementation.
 */
export interface HotCacheStore {
  readonly stats: CacheClientStats
  /** HSET fields and refresh the TTL in one round trip. */
  hset(key: string, values: Record<string, string>, ttlSeconds: number): Promise<void>
  hgetall(key: string): Promise<Record<string, string> | null>
  del(keys: readonly string[]): Promise<void>
  ping(): Promise<boolean>
  close(): Promise<void>
}

export const CACHE_DEFAULTS = {
  /** Command budget on a request path: one attempt, no retry (plan §5.1). */
  commandTimeoutMs: 80,
  /** Consecutive failures open the breaker for this long, then half-open probes. */
  breakerMs: 5000,
  /** Preview-frame TTL, matching `previewTtlMs`. */
  previewTtlMs: 60_000,
  /** Build-progress projection TTL. */
  progressTtlMs: 300_000,
  /** Process-wide progress write throttle. */
  progressThrottleMs: 200,
  /** A single field above this size is not cached; the reader falls back. */
  maxFieldBytes: 256 * 1024,
  /** Latency histogram bounds in seconds (plan SLO: p95 <= 5 ms). */
  latencyBuckets: [0.001, 0.005, 0.01, 0.05, 0.1],
} as const

/**
 * Key namespace: `genoffice:{dbScope}:`. The scope is the MySQL database name so
 * two deployments sharing one Redis cannot read each other's projections.
 */
export function cacheKeyPrefix(scope: string): string {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(scope)) throw new Error('invalid cache scope')
  return `genoffice:${scope}:`
}

const ARTIFACT_KEY = /^[a-f0-9]{64}$/
const JOB_ID = /^[A-Za-z0-9._-]{8,64}$/

/** Preview frames are bound to the build's jobId, never to the artifactKey alone. */
export function previewCacheKey(prefix: string, artifactKey: string, jobId: string): string {
  if (!ARTIFACT_KEY.test(artifactKey)) throw new Error('invalid artifact key')
  if (!JOB_ID.test(jobId)) throw new Error('invalid job id')
  return `${prefix}pv:${artifactKey}:${jobId}`
}

export function progressCacheKey(prefix: string, jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error('invalid job id')
  return `${prefix}job:${jobId}`
}

export interface CacheLatency {
  /**
   * Cumulative observation counts: entry i counts reads at or below
   * CACHE_DEFAULTS.latencyBuckets[i]; the final entry is the implicit +Inf
   * bucket (equal to `count`). This is the Prometheus histogram convention.
   */
  buckets: number[]
  count: number
  sum: number
}

/** Health/metrics projection. Redis failures only degrade: they never fail a request. */
export interface CacheStatsSnapshot {
  mode: CacheMode
  enabled: boolean
  hits: number
  misses: number
  errors: number
  timeouts: number
  /** hits / (hits + misses) over the process lifetime; 0 when no reads happened. */
  hitRate: number
  commands: number
  breaker: 'closed' | 'open'
  lastErrorAt: number | null
  latency: CacheLatency
}

export interface HotCacheProgress {
  unitsProduced: number
  unitCount: number
}

/**
 * Cache facade used by the HTTP layer. Memory mode keeps today's in-process
 * behaviour; redis mode mirrors frames/progress and lets another instance serve
 * the building first screen.
 */
export interface HotCache {
  readonly mode: CacheMode
  readonly enabled: boolean
  /** Mirror a build observer event; never throws into a build. */
  report(jobId: string | undefined, key: string, event: BuildPreviewEvent): void
  /** Local snapshot first, then the shared cache (redis mode only). */
  lookup(key: string, jobId?: string): Promise<PreviewSnapshot | undefined>
  /** Throttled progress projection; force at the end of a build. */
  reportProgress(jobId: string, unitsProduced: number, unitCount: number, force?: boolean): void
  /** Read the projection (negative-only: missing means "unknown", not "ready"). */
  readProgress(jobId: string): Promise<HotCacheProgress | undefined>
  stats(): CacheStatsSnapshot
  close(): Promise<void>
}

export interface HotCacheOptions {
  mode: CacheMode
  /** Required when mode is `redis`; ignored (never called) in memory mode. */
  store?: HotCacheStore
  /** Defaults to `genoffice:default:` for tests/embeddings; the server passes the DB scope. */
  keyPrefix?: string
  /**
   * Shared in-process registry. The server keeps this instance for health stats
   * and shutdown, so the hub must reuse it instead of creating a second one.
   */
  previewRegistry?: import('./artifact-preview').PreviewRegistry
  /** Must match the in-process preview retention (default 8). */
  previewMaxUnits: number
  previewTtlMs?: number
  progressTtlMs?: number
  progressThrottleMs?: number
  maxFieldBytes?: number
  now?: () => number
}
