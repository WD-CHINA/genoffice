import { numberEnv } from './runtime-options'
import { resolve } from 'node:path'
import { createParseServer } from './server'
import { mysqlConfigFromEnv } from './mysql'

const port = numberEnv('PARSE_SERVER_PORT', 0, 65535) ?? 8787
const host = process.env.PARSE_SERVER_HOST ?? '127.0.0.1'
const dataDir = resolve(process.env.PARSE_SERVER_DATA_DIR ?? '.parse-server-data')

const server = await createParseServer({
  dataDir,
  port,
  host,
  token: process.env.PARSE_SERVER_TOKEN || undefined,
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
