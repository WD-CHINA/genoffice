import { expect, it } from 'vitest'
import { createHotCache } from '../src/hot-cache'
import { createRedisCacheStore } from '../src/redis-cache-client'
import { startFakeRedisServer } from './helpers/fake-redis-server'

/** Slow-but-alive Redis (plan §5.1 fault: p99 500 ms) must only degrade. */
it('times out slow Redis commands, opens the breaker and fails fast afterwards', async () => {
  const fake = await startFakeRedisServer({ delayMs: 300 })
  await fake.listen()
  const prefix = 'genoffice:slow-test:'
  const store = createRedisCacheStore(
    { host: '127.0.0.1', port: fake.port },
    { timeoutMs: 60, breakerMs: 150 },
  )
  const cache = createHotCache({
    mode: 'redis',
    store,
    keyPrefix: prefix,
    previewMaxUnits: 4,
    progressThrottleMs: 0,
  })
  try {
    const artifactKey = 'a'.repeat(64)
    // Three lookups time out; each must resolve as a miss within the budget.
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now()
      const snapshot = await cache.lookup(artifactKey, 'slow-job-0001')
      expect(snapshot).toBeUndefined()
      expect(performance.now() - started).toBeLessThan(1000)
    }
    let stats = cache.stats()
    expect(stats.errors).toBeGreaterThan(0)
    expect(stats.timeouts).toBeGreaterThanOrEqual(3)
    expect(stats.breaker).toBe('open')
    const commandsBefore = stats.commands
    // The open breaker rejects immediately: no command on the request path.
    const started = performance.now()
    expect(await cache.lookup(artifactKey, 'slow-job-0001')).toBeUndefined()
    expect(performance.now() - started).toBeLessThan(50)
    stats = cache.stats()
    expect(stats.commands).toBe(commandsBefore)
  } finally {
    await cache.close()
    await fake.close()
  }
})
