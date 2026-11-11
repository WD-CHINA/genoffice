import { performance } from 'node:perf_hooks'
import { canonicalJson } from './artifact-store'
import {
  PreviewRegistry,
  parsePreviewDocument,
  type BuildPreviewEvent,
  type PreviewSnapshot,
} from './artifact-preview'
import {
  CACHE_DEFAULTS,
  previewCacheKey,
  progressCacheKey,
  type CacheClientStats,
  type CacheLatency,
  type CacheMode,
  type CacheStatsSnapshot,
  type HotCache,
  type HotCacheOptions,
  type HotCacheProgress,
  type HotCacheStore,
} from './cache-contract'

/**
 * Optional hot-cache facade (plan §5.1).
 *
 * Memory mode is a thin delegation to the existing in-process PreviewRegistry.
 * Redis mode mirrors preview frames and the build-progress projection so another
 * instance can serve a building artifact's first screen. Truth never moves into
 * Redis: every read here is a hint for the "not ready yet" path and a positive
 * ready decision still has to go through the catalog lease and ready pointer.
 *
 * Nothing on a request or build path may throw because the cache is broken: all
 * store calls are best-effort, malformed values are treated as misses, and
 * failures only increment counters.
 */

const DEFAULT_KEY_PREFIX = 'genoffice:default:'
/** Bounded wait for in-flight best-effort writes during shutdown. */
const CLOSE_FLUSH_TIMEOUT_MS = 2_000
/** Mirrors the in-process registry's unitCount ceiling. */
const MAX_UNIT_COUNT = 100_000
/** Stop timer-related state from growing without bound on misconfigured options. */
const MAX_THROTTLE_MS = 3_600_000
/** Upper bound on remembered per-build mirror decisions. */
const MAX_MIRROR_STATE = 256
/** Strict non-negative integer without signs, leading zeros or fractions. */
const INTEGER = /^(?:0|[1-9]\d{0,15})$/

type DocumentEvent = Extract<BuildPreviewEvent, { type: 'document' }>
type UnitEvent = Extract<BuildPreviewEvent, { type: 'unit' }>

type MirrorMode = 'mirroring' | 'stopped' | 'suppressed'

interface MirrorState {
  mode: MirrorMode
  updatedAt: number
}

interface PendingProgress {
  unitsProduced: number
  unitCount: number
}

function requireInteger(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > 2_147_483_647)
    throw new Error('invalid hot cache ' + name)
}

/** TTLs are configured in milliseconds; the store speaks whole seconds. */
function ttlSeconds(ttlMs: number): number {
  return Math.max(1, Math.ceil(ttlMs / 1000))
}

function parseInteger(value: string | undefined, max?: number): number | undefined {
  if (value === undefined || !INTEGER.test(value)) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined
  if (max !== undefined && parsed > max) return undefined
  return parsed
}

function latestTimestamp(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

function validProgress(unitsProduced: number, unitCount: number): boolean {
  return Number.isSafeInteger(unitsProduced) && Number.isSafeInteger(unitCount) &&
    unitsProduced >= 0 && unitCount >= 0 && unitsProduced <= unitCount
}

class HotCacheHub implements HotCache {
  readonly mode: CacheMode
  readonly enabled: boolean

  private readonly store: HotCacheStore | undefined
  private readonly prefix: string
  private readonly registry: PreviewRegistry
  private readonly previewMaxUnits: number
  private readonly previewTtlSeconds: number
  private readonly progressTtlSeconds: number
  private readonly throttleMs: number
  private readonly maxFieldBytes: number
  private readonly now: () => number

  private hits = 0
  private misses = 0
  private errors = 0
  private lastErrorAt: number | null = null
  private readonly latency: CacheLatency
  private readonly mirrorState = new Map<string, MirrorState>()
  private readonly pendingProgress = new Map<string, PendingProgress>()
  private progressTimer: NodeJS.Timeout | null = null
  private readonly inflight = new Set<Promise<void>>()
  private closed = false
  private storeClosed = false

  constructor(options: HotCacheOptions) {
    if (options.mode !== 'memory' && options.mode !== 'redis')
      throw new Error('invalid hot cache mode')
    this.mode = options.mode
    // Memory mode never touches the store, even when an embedding passes one.
    this.store = options.mode === 'redis' ? options.store : undefined
    this.enabled = this.store !== undefined
    this.prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    if (typeof this.prefix !== 'string' || !this.prefix)
      throw new Error('invalid hot cache keyPrefix')
    requireInteger(options.previewMaxUnits, 'previewMaxUnits', 1)
    this.previewMaxUnits = options.previewMaxUnits
    const previewTtlMs = options.previewTtlMs ?? CACHE_DEFAULTS.previewTtlMs
    requireInteger(previewTtlMs, 'previewTtlMs', 1)
    this.previewTtlSeconds = ttlSeconds(previewTtlMs)
    const progressTtlMs = options.progressTtlMs ?? CACHE_DEFAULTS.progressTtlMs
    requireInteger(progressTtlMs, 'progressTtlMs', 1)
    this.progressTtlSeconds = ttlSeconds(progressTtlMs)
    const throttleMs = options.progressThrottleMs ?? CACHE_DEFAULTS.progressThrottleMs
    requireInteger(throttleMs, 'progressThrottleMs', 0)
    if (throttleMs > MAX_THROTTLE_MS) throw new Error('invalid hot cache progressThrottleMs')
    this.throttleMs = throttleMs
    const maxFieldBytes = options.maxFieldBytes ?? CACHE_DEFAULTS.maxFieldBytes
    requireInteger(maxFieldBytes, 'maxFieldBytes', 1)
    this.maxFieldBytes = maxFieldBytes
    this.now = options.now ?? Date.now
    // The server keeps its own registry for health stats/shutdown and passes it
    // in; creating a second one would fork preview state.
    this.registry = options.previewRegistry ??
      new PreviewRegistry({ maxUnits: options.previewMaxUnits, ttlMs: previewTtlMs, now: this.now })
    this.latency = {
      buckets: Array.from({ length: CACHE_DEFAULTS.latencyBuckets.length + 1 }, () => 0),
      count: 0,
      sum: 0,
    }
  }

  report(jobId: string | undefined, key: string, event: BuildPreviewEvent): void {
    if (this.closed) return
    // The in-process registry stays authoritative for this instance.
    this.registry.report(key, event)
    const store = this.store
    if (!store || !jobId || typeof key !== 'string' || !key) return
    let pvKey: string
    try {
      pvKey = previewCacheKey(this.prefix, key, jobId)
    } catch (error) {
      // Invalid identifiers are a wiring bug; never let them fail a build.
      this.recordError(error)
      return
    }
    try {
      if (event.type === 'document') {
        this.mirrorDocument(key, pvKey, event)
        this.projectProgress(key, jobId, false)
        return
      }
      if (event.type === 'unit') {
        this.mirrorUnit(key, pvKey, event)
        // Throttled projection: the builder is the single writer for this jobId.
        this.projectProgress(key, jobId, false)
        return
      }
      if (event.type === 'failed') {
        // Failures are final: drop the preview frame and the projection now.
        this.forgetMirrorState(pvKey)
        this.forgetProgress(jobId)
        this.background(() => store.del([pvKey, progressCacheKey(this.prefix, jobId)]))
        return
      }
      // done: flush the last progress value so other instances stop polling SQL,
      // then keep the preview frame until its TTL expires. Never mark ready here.
      this.projectProgress(key, jobId, true)
      this.forgetMirrorState(pvKey)
    } catch (error) {
      this.recordError(error)
    }
  }

  async lookup(key: string, jobId?: string): Promise<PreviewSnapshot | undefined> {
    if (this.closed) return this.registry.get(key)
    const started = performance.now()
    try {
      const local = this.registry.get(key)
      if (local) {
        this.hits++
        return local
      }
      const store = this.store
      // A key without its jobId is not a cache key: never scan/fuzzy-match here.
      if (!store || !jobId) {
        this.misses++
        return undefined
      }
      let pvKey: string
      try {
        pvKey = previewCacheKey(this.prefix, key, jobId)
      } catch {
        this.misses++
        return undefined
      }
      let hash: Record<string, string> | null
      try {
        hash = await store.hgetall(pvKey)
      } catch (error) {
        this.recordError(error)
        return undefined
      }
      const snapshot = hash ? this.snapshotFromHash(key, hash) : undefined
      if (snapshot) this.hits++
      else this.misses++
      return snapshot
    } finally {
      this.recordReadLatency(started)
    }
  }

  /** Only the build owner writes; readers compare with SQL and take the max. */
  reportProgress(jobId: string, unitsProduced: number, unitCount: number, force = false): void {
    if (this.closed) return
    if (!this.store) return
    if (!validProgress(unitsProduced, unitCount)) return
    try {
      progressCacheKey(this.prefix, jobId)
    } catch {
      return
    }
    this.pendingProgress.set(jobId, { unitsProduced, unitCount })
    if (force) {
      this.pendingProgress.delete(jobId)
      this.writeProgressNow(jobId, unitsProduced, unitCount)
      return
    }
    // One process-wide timer: a busy build storm must not create one timer per build.
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      this.flushProgress()
    }, this.throttleMs)
    this.progressTimer.unref()
  }

  /** Negative-only projection: callers apply max(redis, sql) themselves. */
  async readProgress(jobId: string): Promise<HotCacheProgress | undefined> {
    if (this.closed) return undefined
    const started = performance.now()
    try {
      const store = this.store
      if (!store) return undefined
      let key: string
      try {
        key = progressCacheKey(this.prefix, jobId)
      } catch {
        return undefined
      }
      let hash: Record<string, string> | null
      try {
        hash = await store.hgetall(key)
      } catch (error) {
        this.recordError(error)
        return undefined
      }
      if (!hash || typeof hash !== 'object') return undefined
      const unitsProduced = parseInteger(hash.unitsProduced)
      const unitCount = parseInteger(hash.unitCount)
      if (unitsProduced === undefined || unitCount === undefined) return undefined
      if (unitsProduced > unitCount) return undefined
      return { unitsProduced, unitCount }
    } finally {
      this.recordReadLatency(started)
    }
  }

  stats(): CacheStatsSnapshot {
    const client: CacheClientStats | undefined = this.store?.stats
    const reads = this.hits + this.misses
    return {
      mode: this.mode,
      enabled: this.enabled,
      hits: this.hits,
      misses: this.misses,
      // Failures the facade observed itself (transport, timeout, malformed value).
      errors: this.errors,
      timeouts: client?.timeouts ?? 0,
      hitRate: reads === 0 ? 0 : this.hits / reads,
      commands: client?.commands ?? 0,
      breaker: client && client.breakerOpenedAt !== null ? 'open' : 'closed',
      lastErrorAt: latestTimestamp(this.lastErrorAt, client?.lastErrorAt ?? null),
      latency: {
        buckets: [...this.latency.buckets],
        count: this.latency.count,
        sum: this.latency.sum,
      },
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.progressTimer) {
      clearTimeout(this.progressTimer)
      this.progressTimer = null
    }
    this.pendingProgress.clear()
    this.mirrorState.clear()
    this.registry.clear()
    // Give already-issued best-effort writes a bounded chance to reach the store.
    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS)
          timer.unref()
        }),
      ])
    }
    const store = this.store
    if (store && !this.storeClosed) {
      this.storeClosed = true
      try {
        await store.close()
      } catch (error) {
        this.recordError(error)
      }
    }
  }

  /**
   * Project the registry's committed progress for a build job. Called from the
   * observer, so every instance serves the same unitsProduced value while the
   * build runs; `done` forces the last write (see report()).
   */
  private projectProgress(key: string, jobId: string, force: boolean): void {
    const state = this.registry.peek(key)
    if (!state) return
    this.reportProgress(jobId, state.unitsProduced, state.unitCount, force)
  }

  private mirrorDocument(key: string, pvKey: string, event: DocumentEvent): void {
    const store = this.store
    if (!store) return
    this.forgetMirrorState(pvKey)
    const document = this.encodeDocument(event)
    // A document that cannot be mirrored means no cross-node first screen for
    // this build at all; an earlier frame for the same build must not survive.
    if (document === undefined) {
      this.suppressMirror(pvKey)
      return
    }
    const values: Record<string, string> = {
      format: event.format,
      document,
      unitCount: String(event.unitCount),
      unitsProduced: '0',
      count: '0',
      updatedAt: String(this.now()),
    }
    const styles = this.encodeOptional(event.styles)
    if (styles !== undefined) values.styles = styles
    this.background(() => store.hset(pvKey, values, this.previewTtlSeconds))
  }

  private mirrorUnit(key: string, pvKey: string, event: UnitEvent): void {
    const store = this.store
    if (!store) return
    const mirror = this.mirrorState.get(pvKey)
    if (mirror && mirror.mode !== 'mirroring') return
    const state = this.registry.peek(key)
    // Only frames the local registry actually retained may be mirrored, and
    // only while the retained range is strictly consecutive. Once a frame is
    // skipped everything after it reads as pending.
    if (!state || state.complete || state.cachedUntil !== event.index + 1 ||
      state.unitsProduced !== event.unitsProduced) {
      this.stopMirror(pvKey)
      return
    }
    let unit: string
    try {
      unit = canonicalJson(event.unit)
    } catch {
      this.stopMirror(pvKey)
      return
    }
    if (Buffer.byteLength(unit) > this.maxFieldBytes) {
      this.stopMirror(pvKey)
      return
    }
    const values: Record<string, string> = {
      ['unit:' + event.index]: unit,
      unitsProduced: String(event.unitsProduced),
      count: String(state.cachedUntil),
      updatedAt: String(this.now()),
    }
    this.mirrorState.set(pvKey, { mode: 'mirroring', updatedAt: this.now() })
    this.background(() => store.hset(pvKey, values, this.previewTtlSeconds))
  }

  /** Strict reader: any malformed field invalidates the whole projection. */
  private snapshotFromHash(key: string, hash: Record<string, string>): PreviewSnapshot | undefined {
    if (typeof hash !== 'object' || Array.isArray(hash)) return undefined
    const format = hash.format
    if (format !== 'pptx' && format !== 'docx') return undefined
    const rawDocument = hash.document
    if (typeof rawDocument !== 'string') return undefined
    let value: unknown
    try {
      value = JSON.parse(rawDocument)
    } catch {
      return undefined
    }
    const document = parsePreviewDocument(value)
    if (!document || document.model.format !== format) return undefined
    const unitCount = parseInteger(hash.unitCount, MAX_UNIT_COUNT)
    if (unitCount === undefined) return undefined
    const unitsProduced = parseInteger(hash.unitsProduced, unitCount)
    if (unitsProduced === undefined) return undefined
    const count = parseInteger(hash.count, this.previewMaxUnits)
    if (count === undefined || count > unitsProduced) return undefined
    const units: unknown[] = []
    for (let index = 0; index < count; index++) {
      const rawUnit = hash['unit:' + index]
      if (typeof rawUnit !== 'string') return undefined
      try {
        units.push(JSON.parse(rawUnit))
      } catch {
        return undefined
      }
    }
    let styles: unknown
    if (hash.styles !== undefined) {
      if (typeof hash.styles !== 'string') return undefined
      try {
        styles = JSON.parse(hash.styles)
      } catch {
        return undefined
      }
    }
    // Absent/invalid updatedAt only affects display metadata; the frame is still usable.
    const updatedAt = parseInteger(hash.updatedAt) ?? this.now()
    return {
      key,
      format,
      document,
      ...(styles !== undefined ? { styles } : {}),
      unitCount,
      unitsProduced,
      cachedUntil: count,
      units,
      // Never claim completeness from the cache: the manifest/ready pointer is truth.
      complete: false,
      previewable: unitsProduced > 0 && count > 0,
      updatedAt,
    }
  }

  private encodeDocument(event: DocumentEvent): string | undefined {
    const document = parsePreviewDocument(event.document)
    if (!document || document.model.format !== event.format) return undefined
    if (!Number.isSafeInteger(event.unitCount) || event.unitCount < 0 ||
      event.unitCount > MAX_UNIT_COUNT) return undefined
    let encoded: string
    try {
      encoded = canonicalJson(event.document)
    } catch {
      return undefined
    }
    return Buffer.byteLength(encoded) > this.maxFieldBytes ? undefined : encoded
  }

  private encodeOptional(value: unknown): string | undefined {
    if (value === undefined) return undefined
    let encoded: string
    try {
      encoded = canonicalJson(value)
    } catch {
      return undefined
    }
    return Buffer.byteLength(encoded) > this.maxFieldBytes ? undefined : encoded
  }

  private stopMirror(pvKey: string): void {
    this.mirrorState.set(pvKey, { mode: 'stopped', updatedAt: this.now() })
    this.pruneMirrorState()
  }

  private suppressMirror(pvKey: string): void {
    const store = this.store
    this.mirrorState.set(pvKey, { mode: 'suppressed', updatedAt: this.now() })
    this.pruneMirrorState()
    if (store) this.background(() => store.del([pvKey]))
  }

  private forgetMirrorState(pvKey: string): void {
    this.mirrorState.delete(pvKey)
  }

  private pruneMirrorState(): void {
    if (this.mirrorState.size <= MAX_MIRROR_STATE) return
    const cutoff = this.now() - this.previewTtlSeconds * 1000
    for (const [pvKey, state] of this.mirrorState)
      if (state.updatedAt < cutoff) this.mirrorState.delete(pvKey)
  }

  private forgetProgress(jobId: string): void {
    this.pendingProgress.delete(jobId)
    if (this.pendingProgress.size > 0 || !this.progressTimer) return
    clearTimeout(this.progressTimer)
    this.progressTimer = null
  }

  private flushProgress(): void {
    if (this.closed || this.pendingProgress.size === 0) return
    const pending = [...this.pendingProgress]
    this.pendingProgress.clear()
    for (const [jobId, progress] of pending)
      this.writeProgressNow(jobId, progress.unitsProduced, progress.unitCount)
  }

  private writeProgressNow(jobId: string, unitsProduced: number, unitCount: number): void {
    const store = this.store
    if (!store) return
    let key: string
    try {
      key = progressCacheKey(this.prefix, jobId)
    } catch (error) {
      this.recordError(error)
      return
    }
    const values: Record<string, string> = {
      unitsProduced: String(unitsProduced),
      unitCount: String(unitCount),
      updatedAt: String(this.now()),
    }
    this.background(() => store.hset(key, values, this.progressTtlSeconds))
  }

  /** Fire-and-forget store work: every rejection is caught and only counted. */
  private background(operation: () => Promise<void>): void {
    if (this.closed) return
    let promise: Promise<void>
    try {
      promise = Promise.resolve(operation())
    } catch (error) {
      this.recordError(error)
      return
    }
    const tracked = promise.then(
      () => undefined,
      (error: unknown) => {
        this.recordError(error)
      },
    )
    this.inflight.add(tracked)
    void tracked.finally(() => {
      this.inflight.delete(tracked)
    })
  }

  private recordReadLatency(started: number): void {
    // Latency only covers read paths; write failures show up in errors.
    if (!this.store) return
    const seconds = Math.max(0, (performance.now() - started) / 1000)
    this.latency.count++
    this.latency.sum += seconds
    const bounds = CACHE_DEFAULTS.latencyBuckets
    // Cumulative buckets: every observation counts toward its own bucket and
    // the implicit +Inf bucket, exactly like a Prometheus histogram.
    for (let position = 0; position < bounds.length; position++)
      if (seconds <= bounds[position]) this.latency.buckets[position]++
    this.latency.buckets[bounds.length]++
  }

  private recordError(_error: unknown): void {
    this.errors++
    this.lastErrorAt = this.now()
  }
}

export function createHotCache(options: HotCacheOptions): HotCache {
  return new HotCacheHub(options)
}
