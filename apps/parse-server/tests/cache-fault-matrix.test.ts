import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createHotCache } from '../src/hot-cache'
import { createRedisCacheStore } from '../src/redis-cache-client'

const socketPath = process.env.PARSE_TEST_REDIS_SOCKET

describe.skipIf(!socketPath)('hot cache fault matrix over real Redis', () => {
  it('treats bulk simultaneous expiry as misses and keeps a hot key consistent', async () => {
    const prefix = `genoffice:fault:${randomUUID()}:`
    const store = createRedisCacheStore({ socketPath }, { timeoutMs: 500, breakerMs: 500 })
    const cache = createHotCache({
      mode: 'redis',
      store,
      keyPrefix: prefix,
      previewMaxUnits: 4,
      progressThrottleMs: 0,
    })
    try {
      // Same-instant expiry: many keys share a 1 s TTL and all disappear together.
      const keys = Array.from({ length: 24 }, (_, index) => prefix + 'expire-' + index)
      await Promise.all(keys.map((key) => store.hset(key, { value: 'x' }, 1)))
      expect((await store.hgetall(keys[0]))?.value).toBe('x')
      await new Promise((resolve) => setTimeout(resolve, 1200))
      for (const key of keys) expect(await store.hgetall(key)).toBeNull()

      // Hot-key read storm: one artifact key queried concurrently many times.
      const artifactKey = 'b'.repeat(64)
      const jobId = 'hot-key-job-0001'
      const started = performance.now()
      const results = await Promise.all(
        Array.from({ length: 64 }, () => cache.lookup(artifactKey, jobId)),
      )
      expect(results.every((value) => value === undefined)).toBe(true)
      expect(performance.now() - started).toBeLessThan(5000)
      const stats = cache.stats()
      expect(stats.errors).toBe(0)
      expect(stats.misses).toBeGreaterThanOrEqual(64)
      expect(stats.latency.count).toBeGreaterThanOrEqual(64)
      // A real Redis round trip is far below the p95 SLO bound on a local socket.
      expect(stats.latency.count).toBeGreaterThan(0)
    } finally {
      await cache.close()
    }
  })
})
