import { isAbsolute } from 'node:path'
import { CACHE_DEFAULTS } from './cache-contract'
import { WORK_POOL_DEFAULTS } from './work-pools'
import type { ParseServerOptions } from './server'
import { resolveMediaOptions } from './media-options'

const MAX_TIMER = 2_147_483_647
/** Reject malformed overrides rather than silently restoring a default or disabling a cap. */
export function numberEnv(
  name: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

export function validateRuntimeOptions(options: ParseServerOptions): void {
  const media = resolveMediaOptions(options.media)
  if (media.enabled && !options.mysql) throw new Error('media conversion requires mysql')
  const integer = (name: keyof ParseServerOptions, fallback: number, min: number, max: number) => {
    const value = options[name] ?? fallback
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`invalid ${name}: expected integer ${min}..${max}`)
    return value
  }
  integer('port', 0, 0, 65535)
  const heap = integer('workerMemoryMb', 512, 8, 1_048_576)
  const rss = integer('workerRssMb', 4096, 16, 1_048_576)
  const total = integer('parseMemoryMb', 8192, 16, 1_048_576)
  if (heap >= rss || rss > total)
    throw new Error(
      'worker heap must be below worker RSS, and worker RSS must fit the total parse memory budget',
    )
  integer('rssSampleMs', 250, 10, 5000)
  integer('workerLifetimeMs', 600_000, 1, MAX_TIMER)
  integer('parseTimeoutMs', 60_000, 1, MAX_TIMER)
  integer('unitTimeoutMs', 30_000, 1, MAX_TIMER)
  integer('gcIntervalMs', 600_000, 1, MAX_TIMER)
  integer('generationRetainCount', 4, 1, 64)
  integer('readyEvictionIdleMs', 60_000, 0, 2_147_483_647)
  integer('readyEvictionBatchSize', 16, 1, 4096)
  const pressureRoundMs = integer('pressureRoundMs', 300_000, 1000, MAX_TIMER)
  const pressureCooldownMs = integer('pressureCooldownMs', 30_000, 1000, MAX_TIMER)
  if (pressureCooldownMs > pressureRoundMs)
    throw new Error('pressure cooldown must not exceed the pressure round duration')
  integer('previewMaxUnits', 8, 1, 64)
  integer('previewTtlMs', 60_000, 1000, MAX_TIMER)
  const cacheMode = options.cacheMode ?? 'memory'
  if (cacheMode !== 'memory' && cacheMode !== 'redis')
    throw new Error("invalid cacheMode: expected 'memory' or 'redis'")
  if (cacheMode === 'redis') {
    // Cross-node preview only makes sense with shared truth: the MySQL database
    // gives the key scope, and two instances are the documented enablement
    // criterion (plan §5.1). Single-node deployments stay on the default.
    if (!options.mysql) throw new Error('cacheMode redis requires mysql')
    // Only the catalog backend publishes a shared parse_jobs row, which is what
    // lets another instance resolve the preview/progress key by jobId.
    if (options.artifactBackend !== 'catalog')
      throw new Error('cacheMode redis requires the catalog artifact backend')
    if (!options.redis && !options.cacheStore)
      throw new Error('cacheMode redis requires a redis configuration')
  }
  if (options.redis) {
    const { host, port, socketPath, username, password, db, tls } = options.redis
    if (host !== undefined && (typeof host !== 'string' || !host.trim()))
      throw new Error('invalid redis host')
    if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
      throw new Error('invalid redis port')
    if (socketPath !== undefined && (!socketPath || !isAbsolute(socketPath)))
      throw new Error('redis socketPath must be an absolute path')
    if (socketPath === undefined && host === undefined)
      throw new Error('redis configuration needs host/port or socketPath')
    if (username !== undefined && typeof username !== 'string')
      throw new Error('invalid redis username')
    if (password !== undefined && typeof password !== 'string')
      throw new Error('invalid redis password')
    if (db !== undefined && (!Number.isSafeInteger(db) || db < 0 || db > 1024))
      throw new Error('invalid redis database index')
    if (tls !== undefined && typeof tls !== 'boolean') throw new Error('invalid redis tls flag')
  }
  integer('cacheCommandTimeoutMs', CACHE_DEFAULTS.commandTimeoutMs, 10, 5000)
  integer('cacheBreakerMs', CACHE_DEFAULTS.breakerMs, 100, 60_000)
  integer('cacheProgressTtlMs', CACHE_DEFAULTS.progressTtlMs, 1000, MAX_TIMER)
  integer('cacheProgressThrottleMs', CACHE_DEFAULTS.progressThrottleMs, 0, 60_000)
  integer('cacheMaxFieldBytes', CACHE_DEFAULTS.maxFieldBytes, 1024, 16 * 1024 ** 2)
  integer('idempotencyTtlMs', 600_000, 1000, MAX_TIMER)
  integer('idempotencyMaxEntries', 256, 1, 100_000)
  if (options.asyncSessionsV2 !== undefined && typeof options.asyncSessionsV2 !== 'boolean')
    throw new Error('invalid asyncSessionsV2: expected a boolean')
  integer('v2RolloutPercent', 100, 0, 100)
  integer('v2RolloutRampPerHour', 0, 0, 100)
  integer('v2AutoPauseErrorRate', 0, 0, 100)
  if (options.canonicalArtifactExport !== undefined &&
    typeof options.canonicalArtifactExport !== 'boolean')
    throw new Error('invalid canonicalArtifactExport')
  if (options.previousToken !== undefined) {
    if (typeof options.previousToken !== 'string' || options.previousToken.length < 1)
      throw new Error('invalid previousToken')
    if (!options.token) throw new Error('previousToken requires token')
    if (options.previousToken === options.token)
      throw new Error('previousToken must differ from token')
  }
  if (options.v2RolloutHeader !== undefined &&
    (typeof options.v2RolloutHeader !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(options.v2RolloutHeader)))
    throw new Error('invalid v2RolloutHeader')
  integer('shutdownTimeoutMs', 30_000, 1, 600_000)
  integer('docxAutoRemoteBytes', 32 * 1024 * 1024, 1, 1024 ** 3)
  integer('pptxAutoRemoteBytes', 64 * 1024 * 1024, 1, 1024 ** 3)
  integer('docxFullRenderBytes', 64 * 1024 * 1024, 1, 1024 ** 3)
  const memoryCacheBudgetBytes = integer('memoryCacheBudgetBytes', 2 * 1024 ** 3, 0,
    Number.MAX_SAFE_INTEGER)
  const modelCacheMaxBytes = integer('modelCacheMaxBytes', 256 * 1024 ** 2, 0, Number.MAX_SAFE_INTEGER)
  if (modelCacheMaxBytes > memoryCacheBudgetBytes)
    throw new Error('model cache budget must not exceed the HTTP/index/read memory cache budget')
  integer('httpMaxConcurrency', 128, 1, 100_000)
  integer('diskIoConcurrency', WORK_POOL_DEFAULTS.diskIoConcurrency, 1, 4096)
  integer('inflateConcurrency', WORK_POOL_DEFAULTS.inflateConcurrency, 1, 256)
  integer('buildRetryAttempts', 2, 0, 10)
  integer('sessionTtlMs', 1_800_000, 0, Number.MAX_SAFE_INTEGER)
  integer('contentTtlMs', 604_800_000, 0, Number.MAX_SAFE_INTEGER)
  integer('maxStoreBytes', 20 * 1024 ** 3, 0, Number.MAX_SAFE_INTEGER)
  integer('storageReservationLeaseMs', 300_000, 10_000, 3_600_000)
  const high = integer('storageHighWaterPercent', 90, 2, 100)
  const low = integer('storageLowWaterPercent', 80, 1, 99)
  if (low >= high) throw new Error('storage low watermark must be below high watermark')
  integer('maxSessions', 500, 1, 1_000_000)
  integer('maxParseJobs', 2, 1, 256)
  integer('maxQueuedParseJobs', 20, 0, 1_000_000)
  if (
    options.cgroupRoot !== undefined &&
    (!isAbsolute(options.cgroupRoot) || process.platform !== 'linux')
  )
    throw new Error('cgroupRoot must be an absolute Linux cgroup v2 delegation path')
}
