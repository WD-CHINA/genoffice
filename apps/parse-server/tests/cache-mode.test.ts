import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createParseServer, type ParseServer } from '../src/server'
import { CACHE_DEFAULTS } from '../src/cache-contract'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function start(): Promise<ParseServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'cache-mode-'))
  dirs.push(dataDir)
  const server = await createParseServer({ dataDir })
  servers.push(server)
  return server
}

it('keeps the in-process cache by default and reports it as disabled', async () => {
  const server = await start()
  const health = (await (await fetch(server.url + '/v1/health')).json()) as {
    cache: {
      mode: string
      enabled: boolean
      hits: number
      misses: number
      hitRate: number
      errors: number
      timeouts: number
      commands: number
      breaker: string
      lastErrorAt: number | null
      latency: { buckets: number[]; count: number; sum: number }
    }
  }
  expect(health.cache).toMatchObject({
    mode: 'memory',
    enabled: false,
    hits: 0,
    misses: 0,
    hitRate: 0,
    errors: 0,
    timeouts: 0,
    commands: 0,
    breaker: 'closed',
    lastErrorAt: null,
  })
  expect(health.cache.latency.count).toBe(0)
  expect(health.cache.latency.sum).toBe(0)
  expect(health.cache.latency.buckets).toHaveLength(CACHE_DEFAULTS.latencyBuckets.length + 1)
  // A disabled cache must never pretend to be open to clients, and the local
  // incremental preview stats remain available for compatibility.
  const capabilities = (await (await fetch(server.url + '/v1/capabilities')).json()) as {
    features: Record<string, boolean>
  }
  expect(capabilities.features.incrementalPreview).toBe(true)
})

it('exposes cache gauges and counters on the Prometheus endpoint', async () => {
  const server = await start()
  const body = await (await fetch(server.url + '/metrics')).text()
  expect(body).toContain('genoffice_cache_mode{mode="memory"} 1')
  expect(body).toContain('genoffice_cache_enabled 0')
  expect(body).toContain('genoffice_cache_hit_total 0')
  expect(body).toContain('genoffice_cache_miss_total 0')
  expect(body).toContain('genoffice_cache_error_total 0')
  expect(body).toContain('genoffice_cache_timeout_total 0')
  expect(body).toContain('genoffice_cache_hit_rate 0')
  expect(body).toContain('genoffice_cache_breaker_open 0')
  expect(body).toContain('genoffice_cache_latency_seconds_bucket{le="0.005"} 0')
  expect(body).toContain('genoffice_cache_latency_seconds_count 0')
})

it('refuses a half-configured redis mode before creating any server resource', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cache-mode-'))
  dirs.push(dataDir)
  await expect(createParseServer({ dataDir, cacheMode: 'redis' })).rejects.toThrow('requires mysql')
})
