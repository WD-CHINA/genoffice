import { expect, it } from 'vitest'
import {
  CACHE_DEFAULTS,
  CacheUnavailableError,
  cacheKeyPrefix,
  previewCacheKey,
  progressCacheKey,
} from '../src/cache-contract'
import { validateRuntimeOptions } from '../src/runtime-options'

const base = { dataDir: '/unused-test-directory' }
const mysql = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'genoffice' }

it('defaults to the in-process cache and rejects redis without shared truth', () => {
  expect(() => validateRuntimeOptions(base)).not.toThrow()
  expect(() => validateRuntimeOptions({ ...base, cacheMode: 'memory' })).not.toThrow()
  expect(() => validateRuntimeOptions({ ...base, cacheMode: 'unexpected' as 'memory' })).toThrow(
    'cacheMode',
  )
  // Cross-node preview needs the MySQL catalog scope; a local filesystem index
  // has no shared job row to address the projection.
  expect(() => validateRuntimeOptions({ ...base, cacheMode: 'redis' })).toThrow('requires mysql')
  expect(() => validateRuntimeOptions({ ...base, cacheMode: 'redis', mysql })).toThrow(
    'requires the catalog artifact backend',
  )
  expect(() =>
    validateRuntimeOptions({
      ...base, cacheMode: 'redis', mysql, redis: { host: '127.0.0.1' },
    }),
  ).toThrow('requires the catalog artifact backend')
  expect(() =>
    validateRuntimeOptions({
      ...base, cacheMode: 'redis', mysql, artifactBackend: 'catalog',
      redis: { host: '127.0.0.1' },
    }),
  ).not.toThrow()
})

it('validates the redis endpoint instead of trusting ambient environment values', () => {
  for (const redis of [
    { host: '' },
    { host: '127.0.0.1', port: 0 },
    { host: '127.0.0.1', port: 70_000 },
    { host: '127.0.0.1', port: 1.5 },
    { socketPath: 'relative/redis.sock' },
    { host: '127.0.0.1', db: -1 },
    { host: '127.0.0.1', db: 2048 },
    { host: '127.0.0.1', tls: 'yes' as unknown as boolean },
    { password: 'secret' },
  ]) {
    expect(() => validateRuntimeOptions({ ...base, redis })).toThrow(/redis|host|socketPath/)
  }
  expect(() =>
    validateRuntimeOptions({ ...base, redis: { socketPath: '/tmp/redis.sock' } }),
  ).not.toThrow()
  expect(() =>
    validateRuntimeOptions({
      ...base,
      redis: { host: 'redis.internal', port: 6380, username: 'app', password: 'secret', db: 3, tls: true },
    }),
  ).not.toThrow()
})

it('bounds cache timings so a misconfigured deployment cannot stall a request path', () => {
  expect(() =>
    validateRuntimeOptions({
      ...base,
      cacheCommandTimeoutMs: CACHE_DEFAULTS.commandTimeoutMs,
      cacheBreakerMs: CACHE_DEFAULTS.breakerMs,
      cacheProgressTtlMs: CACHE_DEFAULTS.progressTtlMs,
      cacheProgressThrottleMs: CACHE_DEFAULTS.progressThrottleMs,
      cacheMaxFieldBytes: CACHE_DEFAULTS.maxFieldBytes,
    }),
  ).not.toThrow()
  for (const [key, value, pattern] of [
    ['cacheCommandTimeoutMs', 9, /cacheCommandTimeoutMs/],
    ['cacheCommandTimeoutMs', 5001, /cacheCommandTimeoutMs/],
    ['cacheBreakerMs', 99, /cacheBreakerMs/],
    ['cacheProgressTtlMs', 999, /cacheProgressTtlMs/],
    ['cacheProgressThrottleMs', 60_001, /cacheProgressThrottleMs/],
    ['cacheMaxFieldBytes', 1023, /cacheMaxFieldBytes/],
  ] as const) {
    expect(() => validateRuntimeOptions({ ...base, [key]: value })).toThrow(pattern)
  }
  expect(() => validateRuntimeOptions({ ...base, cacheProgressThrottleMs: 0 })).not.toThrow()
})

it('scopes every key under genoffice:{dbScope}: and binds previews to the job id', () => {
  const prefix = cacheKeyPrefix('genoffice')
  expect(prefix).toBe('genoffice:genoffice:')
  expect(previewCacheKey(prefix, 'a'.repeat(64), 'job-1234')).toBe(
    `genoffice:genoffice:pv:${'a'.repeat(64)}:job-1234`,
  )
  expect(progressCacheKey(prefix, 'job-1234')).toBe('genoffice:genoffice:job:job-1234')
  for (const scope of ['', 'has space', 'a'.repeat(65), 'bad:colon']) {
    expect(() => cacheKeyPrefix(scope)).toThrow('invalid cache scope')
  }
  expect(() => previewCacheKey(prefix, 'not-a-hash', 'job-1234')).toThrow('invalid artifact key')
  expect(() => previewCacheKey(prefix, 'a'.repeat(64), '')).toThrow('invalid job id')
  expect(() => progressCacheKey(prefix, 'not a job')).toThrow('invalid job id')
})

it('marks unavailability with a stable code so HTTP maps it to degradation only', () => {
  const error = new CacheUnavailableError()
  expect(error.code).toBe('cache_unavailable')
  expect(error.name).toBe('CacheUnavailableError')
})
