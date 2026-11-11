import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CACHE_DEFAULTS } from '../src/cache-contract'
import { createHotCache } from '../src/hot-cache'
import { createRedisCacheStore } from '../src/redis-cache-client'

/**
 * Local hot-cache SLO drill (plan §5.1: hit rate >= 80 %, extra p95 <= 5 ms,
 * error rate <= 0.1 %). It exercises the real RESP client against a real Redis
 * instance and reports measured numbers. This is NOT the target-hardware
 * acceptance: run it on the deployment host before enabling `mode=redis`.
 *
 * Usage:
 *   PARSE_TEST_REDIS_SOCKET=/tmp/redis.sock node --import tsx scripts/cache-slo-drill.mts \
 *     [--requests 2000] [--concurrency 8] [--out /tmp/genoffice-cache-slo.json] [--strict]
 */

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf('--' + name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid --${name}`)
  return value
}

const requests = argument('requests', 2000)
const concurrency = Math.min(64, argument('concurrency', 8))
const output = (() => {
  const index = process.argv.indexOf('--out')
  return index >= 0 && process.argv[index + 1]
    ? process.argv[index + 1]
    : join(tmpdir(), 'genoffice-cache-slo.json')
})()
const strict = process.argv.includes('--strict')
const socketPath = process.env.PARSE_TEST_REDIS_SOCKET || process.env.REDIS_SOCKET
const host = process.env.REDIS_HOST
if (!socketPath && !host) {
  console.error('set PARSE_TEST_REDIS_SOCKET/REDIS_SOCKET or REDIS_HOST (+REDIS_PORT)')
  process.exit(2)
}
const config = socketPath
  ? { socketPath }
  : { host: host!, port: Number(process.env.REDIS_PORT ?? 6379) }
const prefix = `genoffice:slo:${randomUUID()}:`
const store = createRedisCacheStore(config, { timeoutMs: 80, breakerMs: 5_000 })
const cache = createHotCache({
  mode: 'redis',
  store,
  keyPrefix: prefix,
  previewMaxUnits: 8,
  progressThrottleMs: 0,
})
const artifactKey = 'c'.repeat(64)
const jobId = `slo-${randomUUID()}`

try {
  // Seed one committed preview through the ordinary observer path, then wait for
  // the best-effort mirror to reach Redis before sampling reads.
  cache.report(jobId, artifactKey, {
    type: 'document', format: 'pptx', unitCount: 2,
    document: { model: { format: 'pptx', unitCount: 2, unitKind: 'slide' }, fonts: [] },
  })
  for (const index of [0, 1]) {
    cache.report(jobId, artifactKey, {
      type: 'unit', index, unit: { index }, unitsProduced: index + 1,
    })
  }
  const warmDeadline = Date.now() + 5_000
  for (;;) {
    const hash = await store.hgetall(`${prefix}pv:${artifactKey}:${jobId}`)
    if (hash?.document && hash['unit:1']) break
    if (Date.now() > warmDeadline) throw new Error('preview mirror never reached Redis')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  if (!(await cache.lookup(artifactKey, jobId))) throw new Error('warm lookup missed')

  let misses = 0
  let completed = 0
  const worker = async (): Promise<void> => {
    while (completed < requests) {
      completed++
      if (!(await cache.lookup(artifactKey, jobId))) misses++
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))

  const stats = cache.stats()
  const bounds = CACHE_DEFAULTS.latencyBuckets
  let p95Seconds = Number.POSITIVE_INFINITY
  for (let index = 0; index < bounds.length; index++) {
    if (stats.latency.buckets[index] >= stats.latency.count * 0.95) {
      p95Seconds = bounds[index]
      break
    }
  }
  const errorRate = stats.latency.count ? stats.errors / stats.latency.count : 0
  const report = {
    measuredAt: new Date().toISOString(),
    target: socketPath ? `unix:${socketPath}` : `tcp:${host}`,
    mode: 'redis',
    requests,
    concurrency,
    hits: stats.hits,
    misses: misses + stats.misses,
    hitRate: stats.hitRate,
    p95BucketSeconds: p95Seconds,
    averageMs: stats.latency.count ? (stats.latency.sum / stats.latency.count) * 1000 : 0,
    errors: stats.errors,
    timeouts: stats.timeouts,
    errorRate,
    slo: {
      hitRate: stats.hitRate >= 0.8,
      p95: p95Seconds <= 0.005,
      errorRate: errorRate <= 0.001,
    },
    note: 'single local Redis over a loopback socket; not target hardware',
  }
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (strict && !(report.slo.hitRate && report.slo.p95 && report.slo.errorRate))
    process.exitCode = 1
} finally {
  await cache.close()
}
