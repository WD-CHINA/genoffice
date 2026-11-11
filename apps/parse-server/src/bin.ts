import { numberEnv } from './runtime-options'
import { resolve } from 'node:path'
import { createParseServer } from './server'
import { mysqlConfigFromEnv } from './mysql'
import { redisConfigFromEnv } from './redis-cache-client'
import { mediaOptionsFromEnv } from './media-options'
import { deploymentOptionsFromEnv } from './deployment-options'
import type { CacheMode } from './cache-contract'

const port = numberEnv('PARSE_SERVER_PORT', 0, 65535) ?? 8787
const host = process.env.PARSE_SERVER_HOST ?? '127.0.0.1'
const dataDir = resolve(process.env.PARSE_SERVER_DATA_DIR ?? '.parse-server-data')

// Deployment switches (catalog backend, shared admission, restore gate) are
// validated before any server resource is created; a typo aborts startup.
const deployment = await deploymentOptionsFromEnv()

const server = await createParseServer({
  media: mediaOptionsFromEnv(),
  ...deployment,
  dataDir,
  port,
  host,
  token: process.env.PARSE_SERVER_TOKEN || undefined,
  previousToken: process.env.PARSE_SERVER_PREVIOUS_TOKEN || undefined,
  allowedOrigins: (process.env.PARSE_SERVER_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  parserVersion: process.env.PARSE_SERVER_PARSER_VERSION || undefined,
  parserFingerprint: process.env.PARSE_SERVER_BUILD_FINGERPRINT || undefined,
  fontSetHash: process.env.PARSE_SERVER_FONT_SET_HASH || undefined,
  limits: {
    maxUploadBytes: numberEnv('PARSE_SERVER_MAX_UPLOAD_BYTES'),
    maxParseBytes: numberEnv('PARSE_SERVER_MAX_PARSE_BYTES'),
  },
  parseTimeoutMs: numberEnv('PARSE_SERVER_PARSE_TIMEOUT_MS'),
  unitTimeoutMs: numberEnv('PARSE_SERVER_UNIT_TIMEOUT_MS'),
  workerMemoryMb: numberEnv('PARSE_SERVER_WORKER_MEMORY_MB'),
  maxSessions: numberEnv('PARSE_SERVER_MAX_SESSIONS'),
  modelCacheMaxBytes: numberEnv('PARSE_SERVER_MODEL_CACHE_MAX_BYTES', 0),
  memoryCacheBudgetBytes: numberEnv('PARSE_SERVER_MEMORY_CACHE_BUDGET_BYTES', 0),
  httpMaxConcurrency: numberEnv('PARSE_SERVER_HTTP_MAX_CONCURRENCY'),
  diskIoConcurrency: numberEnv('PARSE_SERVER_DISK_IO_CONCURRENCY'),
  inflateConcurrency: numberEnv('PARSE_SERVER_INFLATE_CONCURRENCY'),
  buildRetryAttempts: numberEnv('PARSE_SERVER_BUILD_RETRY_ATTEMPTS', 0),
  maxParseJobs: numberEnv('PARSE_SERVER_MAX_PARSE_JOBS'),
  maxQueuedParseJobs: numberEnv('PARSE_SERVER_MAX_QUEUED_PARSE_JOBS', 0),
  workerRssMb: numberEnv('PARSE_SERVER_WORKER_RSS_MB'),
  parseMemoryMb: numberEnv('PARSE_SERVER_PARSE_MEMORY_MB'),
  rssSampleMs: numberEnv('PARSE_SERVER_RSS_SAMPLE_MS'),
  workerLifetimeMs: numberEnv('PARSE_SERVER_WORKER_LIFETIME_MS'),
  cgroupRoot: process.env.PARSE_SERVER_CGROUP_ROOT?.trim() || undefined,
  sessionTtlMs: numberEnv('PARSE_SERVER_SESSION_TTL_MS', 0),
  contentTtlMs: numberEnv('PARSE_SERVER_CONTENT_TTL_MS', 0),
  maxStoreBytes: numberEnv('PARSE_SERVER_MAX_STORE_BYTES', 0),
  storageHighWaterPercent: numberEnv('PARSE_SERVER_STORAGE_HIGH_WATER_PERCENT', 2, 100),
  storageLowWaterPercent: numberEnv('PARSE_SERVER_STORAGE_LOW_WATER_PERCENT', 1, 99),
  gcIntervalMs: numberEnv('PARSE_SERVER_GC_INTERVAL_MS'),
  readyEvictionIdleMs: numberEnv('PARSE_SERVER_READY_EVICTION_IDLE_MS'),
  readyEvictionBatchSize: numberEnv('PARSE_SERVER_READY_EVICTION_BATCH_SIZE'),
  pressureRoundMs: numberEnv('PARSE_SERVER_PRESSURE_ROUND_MS'),
  pressureCooldownMs: numberEnv('PARSE_SERVER_PRESSURE_COOLDOWN_MS'),
  previewMaxUnits: numberEnv('PARSE_SERVER_PREVIEW_MAX_UNITS'),
  previewTtlMs: numberEnv('PARSE_SERVER_PREVIEW_TTL_MS'),
  // Optional cross-node hot cache (plan §5.1). Unset mode/redis keeps the
  // in-process preview only; validation rejects a half-configured redis mode.
  cacheMode: (process.env.PARSE_SERVER_CACHE_MODE?.trim() || undefined) as CacheMode | undefined,
  redis: redisConfigFromEnv() ?? undefined,
  cacheCommandTimeoutMs: numberEnv('PARSE_SERVER_CACHE_COMMAND_TIMEOUT_MS'),
  cacheBreakerMs: numberEnv('PARSE_SERVER_CACHE_BREAKER_MS'),
  cacheProgressTtlMs: numberEnv('PARSE_SERVER_CACHE_PROGRESS_TTL_MS'),
  cacheProgressThrottleMs: numberEnv('PARSE_SERVER_CACHE_PROGRESS_THROTTLE_MS', 0),
  cacheMaxFieldBytes: numberEnv('PARSE_SERVER_CACHE_MAX_FIELD_BYTES'),
  v2RolloutPercent: numberEnv('PARSE_SERVER_V2_ROLLOUT_PERCENT'),
  v2RolloutHeader: process.env.PARSE_SERVER_V2_ROLLOUT_HEADER || undefined,
  v2RolloutRampPerHour: numberEnv('PARSE_SERVER_V2_ROLLOUT_RAMP_PER_HOUR'),
  v2AutoPauseErrorRate: numberEnv('PARSE_SERVER_V2_AUTO_PAUSE_ERROR_RATE'),
  canonicalArtifactExport: ['1', 'true', 'yes', 'on'].includes(
    (process.env.PARSE_SERVER_CANONICAL_ARTIFACT_EXPORT ?? '').toLowerCase(),
  ),
  shutdownTimeoutMs: numberEnv('PARSE_SERVER_SHUTDOWN_TIMEOUT_MS'),
  docxAutoRemoteBytes: numberEnv('PARSE_SERVER_DOCX_AUTO_REMOTE_BYTES'),
  pptxAutoRemoteBytes: numberEnv('PARSE_SERVER_PPTX_AUTO_REMOTE_BYTES'),
  docxFullRenderBytes: numberEnv('PARSE_SERVER_DOCX_FULL_RENDER_BYTES'),
  idempotencyTtlMs: numberEnv('PARSE_SERVER_IDEMPOTENCY_TTL_MS'),
  idempotencyMaxEntries: numberEnv('PARSE_SERVER_IDEMPOTENCY_MAX_ENTRIES'),
  mysql: mysqlConfigFromEnv() ?? undefined,
})

console.log(`[parse-server] listening on ${server.url} (data: ${dataDir})`)

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[parse-server] ${signal}, shutting down`)
  await server.close().catch((error: unknown) => {
    console.error('[parse-server] close failed', error)
  })
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
