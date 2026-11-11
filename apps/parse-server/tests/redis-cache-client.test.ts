import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CacheUnavailableError, type HotCacheStore } from '../src/cache-contract'
import { createRedisCacheStore, redisConfigFromEnv } from '../src/redis-cache-client'
import { startFakeRedisServer, type FakeRedisServer } from './helpers/fake-redis-server'

const REDIS_ENV_KEYS = [
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_SOCKET',
  'REDIS_USERNAME',
  'REDIS_PASSWORD',
  'REDIS_DB',
  'REDIS_TLS',
] as const

const originalEnv = new Map(REDIS_ENV_KEYS.map((key) => [key, process.env[key]]))

function clearRedisEnv(): void {
  for (const key of REDIS_ENV_KEYS) delete process.env[key]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met in time')
    await sleep(5)
  }
}

const servers: FakeRedisServer[] = []
const stores: HotCacheStore[] = []

async function startServer(options?: Parameters<typeof startFakeRedisServer>[0]) {
  const server = await startFakeRedisServer(options)
  await server.listen()
  servers.push(server)
  return server
}

function makeStore(
  server: FakeRedisServer,
  options?: Parameters<typeof createRedisCacheStore>[1],
): HotCacheStore {
  const store = createRedisCacheStore({ host: '127.0.0.1', port: server.port }, options)
  stores.push(store)
  return store
}

beforeEach(() => {
  clearRedisEnv()
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const key of REDIS_ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('redisConfigFromEnv', () => {
  it('returns null when no REDIS_* variable is set', () => {
    expect(redisConfigFromEnv()).toBeNull()
  })

  it('treats empty values as unset', () => {
    process.env.REDIS_HOST = ''
    process.env.REDIS_PASSWORD = ''
    expect(redisConfigFromEnv()).toBeNull()
  })

  it('defaults host and port once any setting is present', () => {
    process.env.REDIS_PASSWORD = 'secret'
    expect(redisConfigFromEnv()).toEqual({ host: '127.0.0.1', port: 6379, password: 'secret' })
  })

  it('lets the unix socket win over host and port', () => {
    process.env.REDIS_SOCKET = '/tmp/genoffice-redis.sock'
    process.env.REDIS_HOST = 'ignored.example'
    process.env.REDIS_PORT = '6380'
    process.env.REDIS_USERNAME = 'genoffice'
    process.env.REDIS_PASSWORD = 'secret'
    process.env.REDIS_DB = '2'
    process.env.REDIS_TLS = 'yes'
    expect(redisConfigFromEnv()).toEqual({
      socketPath: '/tmp/genoffice-redis.sock',
      username: 'genoffice',
      password: 'secret',
      db: 2,
      tls: true,
    })
  })

  it('parses tcp TLS settings', () => {
    process.env.REDIS_HOST = 'redis.internal'
    process.env.REDIS_PORT = '6380'
    process.env.REDIS_TLS = 'on'
    expect(redisConfigFromEnv()).toEqual({ host: 'redis.internal', port: 6380, tls: true })
    process.env.REDIS_TLS = 'off'
    expect(redisConfigFromEnv()).toEqual({ host: 'redis.internal', port: 6380, tls: false })
  })

  it('rejects invalid port, db and tls values', () => {
    process.env.REDIS_PORT = '0'
    expect(() => redisConfigFromEnv()).toThrow('REDIS_PORT')
    process.env.REDIS_PORT = 'not-a-port'
    expect(() => redisConfigFromEnv()).toThrow('REDIS_PORT')
    process.env.REDIS_PORT = '6379'
    process.env.REDIS_DB = '16x'
    expect(() => redisConfigFromEnv()).toThrow('REDIS_DB')
    process.env.REDIS_DB = '1'
    process.env.REDIS_TLS = 'maybe'
    expect(() => redisConfigFromEnv()).toThrow('REDIS_TLS')
  })
})

describe('createRedisCacheStore against a fake RESP server', () => {
  it('round-trips a hash and deletes keys', async () => {
    const server = await startServer()
    const store = makeStore(server)

    expect(await store.ping()).toBe(true)
    await store.hset('genoffice:test:pv:1', { document: '{"a":1}', count: '2' }, 60)
    expect(await store.hgetall('genoffice:test:pv:1')).toEqual({
      document: '{"a":1}',
      count: '2',
    })
    await store.del(['genoffice:test:pv:1'])
    expect(await store.hgetall('genoffice:test:pv:1')).toBeNull()

    expect(server.commands.map((command) => command.name)).toEqual([
      'PING',
      'HSET',
      'EXPIRE',
      'HGETALL',
      'DEL',
      'HGETALL',
    ])
    expect(store.stats).toMatchObject({
      commands: 5,
      errors: 0,
      timeouts: 0,
      breakerOpenedAt: null,
      lastErrorAt: null,
    })
  })

  it('returns null for a missing hash instead of an empty object', async () => {
    const server = await startServer()
    const store = makeStore(server)
    expect(await store.hgetall('genoffice:test:missing')).toBeNull()
  })

  it('sends HSET and EXPIRE as one pipelined write with a positive TTL', async () => {
    const server = await startServer()
    const store = makeStore(server)
    await store.hset('genoffice:test:job:1', { unitsProduced: '3', unitCount: '8' }, 300)

    const hset = server.commands.find((command) => command.name === 'HSET')
    const expire = server.commands.find((command) => command.name === 'EXPIRE')
    expect(hset?.args).toEqual(['genoffice:test:job:1', 'unitsProduced', '3', 'unitCount', '8'])
    expect(expire?.args).toEqual(['genoffice:test:job:1', '300'])
    // Both commands must travel in the same write, otherwise a crash could leave
    // an immortal hash behind.
    expect(expire?.chunk).toBe(hset?.chunk)
    expect(store.stats.commands).toBe(1)
  })

  it('rejects an invalid TTL or empty field set without touching Redis', async () => {
    const server = await startServer()
    const store = makeStore(server)

    await expect(store.hset('k', { a: '1' }, 0)).rejects.toThrow('ttlSeconds')
    await expect(store.hset('k', { a: '1' }, -5)).rejects.toThrow('ttlSeconds')
    await expect(store.hset('k', { a: '1' }, 1.5)).rejects.toThrow('ttlSeconds')
    await expect(store.hset('k', {}, 60)).rejects.toThrow('at least one field')
    await expect(store.hgetall('')).rejects.toThrow('cache key')
    await store.del([])

    expect(server.commands).toHaveLength(0)
    expect(store.stats.commands).toBe(0)
    expect(store.stats.errors).toBe(0)
  })

  it('deletes several keys in one DEL command', async () => {
    const server = await startServer()
    const store = makeStore(server)
    await store.hset('a', { x: '1' }, 60)
    await store.hset('b', { y: '2' }, 60)
    await store.del(['a', 'b'])
    expect(await store.hgetall('a')).toBeNull()
    expect(await store.hgetall('b')).toBeNull()
    const del = server.commands.find((command) => command.name === 'DEL')
    expect(del?.args).toEqual(['a', 'b'])
  })

  it('authenticates with ACL credentials and selects the database first', async () => {
    const server = await startServer({ username: 'genoffice', password: 'secret' })
    const store = createRedisCacheStore({
      host: '127.0.0.1',
      port: server.port,
      username: 'genoffice',
      password: 'secret',
      db: 3,
    })
    stores.push(store)

    expect(await store.ping()).toBe(true)
    expect(server.commands.slice(0, 3).map((command) => [command.name, command.args])).toEqual([
      ['AUTH', ['genoffice', 'secret']],
      ['SELECT', ['3']],
      ['PING', []],
    ])
    // AUTH and SELECT are one handshake write.
    expect(server.commands[0].chunk).toBe(server.commands[1].chunk)
  })

  it('sends AUTH with the password only when no username is configured', async () => {
    const server = await startServer({ password: 'secret' })
    const store = createRedisCacheStore({
      host: '127.0.0.1',
      port: server.port,
      password: 'secret',
    })
    stores.push(store)

    expect(await store.ping()).toBe(true)
    expect(server.commands[0].name).toBe('AUTH')
    expect(server.commands[0].args).toEqual(['secret'])
  })

  it('reports a failed handshake as a counted error and reconnects on the next command', async () => {
    const server = await startServer({ password: 'secret' })
    const store = createRedisCacheStore({
      host: '127.0.0.1',
      port: server.port,
      password: 'wrong',
    })
    stores.push(store)

    expect(await store.ping()).toBe(false)
    expect(store.stats.errors).toBe(1)
    expect(store.stats.commands).toBe(1)
    expect(server.commands[0].name).toBe('AUTH')
  })

  it('degrades to a counted error when the server is unreachable', async () => {
    const store = createRedisCacheStore({ host: '127.0.0.1', port: 1 }, { timeoutMs: 300 })
    stores.push(store)

    expect(await store.ping()).toBe(false)
    expect(await store.ping()).toBe(false)
    expect(store.stats.commands).toBe(2)
    expect(store.stats.errors).toBe(2)
    expect(store.stats.breakerOpenedAt).toBeNull()
    await store.close()
  })

  it('times out a slow command, destroys the connection and counts it once', async () => {
    const server = await startServer({ delayMs: 300 })
    const store = makeStore(server, { timeoutMs: 40 })
    const started = Date.now()

    await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    expect(Date.now() - started).toBeLessThan(250)
    expect(store.stats.timeouts).toBe(1)
    expect(store.stats.errors).toBe(1)
    expect(store.stats.commands).toBe(1)
    expect(store.stats.lastErrorAt).not.toBeNull()
    expect(store.stats.breakerOpenedAt).toBeNull()

    await server.waitForCommands(1)
    await waitFor(() => server.activeConnections === 0)
  })

  it('never retries a command, even after a timeout', async () => {
    const server = await startServer({ delayMs: 200 })
    const store = makeStore(server, { timeoutMs: 30 })

    await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    await server.waitForCommands(1)
    await sleep(80)
    expect(server.commands.filter((command) => command.name === 'HGETALL')).toHaveLength(1)
    expect(store.stats.commands).toBe(1)
  })

  it('counts server error replies as command errors', async () => {
    const server = await startServer()
    const store = makeStore(server)
    server.failNext('WRONGTYPE Operation against a key holding the wrong kind of value')

    await expect(store.hgetall('k')).rejects.toThrow(/WRONGTYPE/)
    expect(store.stats.errors).toBe(1)
    expect(store.stats.timeouts).toBe(0)
    expect(store.stats.commands).toBe(1)
    expect(store.stats.lastErrorAt).not.toBeNull()
    expect(server.commands.filter((command) => command.name === 'HGETALL')).toHaveLength(1)
  })

  it('opens the breaker after three consecutive failures and recovers via a half-open probe', async () => {
    const server = await startServer()
    const store = makeStore(server, { breakerMs: 60 })
    for (let attempt = 0; attempt < 3; attempt += 1) server.failNext('ERR boom')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    }
    expect(store.stats.errors).toBe(3)
    expect(store.stats.breakerOpenedAt).not.toBeNull()

    // While open, commands fail fast without touching Redis and without counting.
    const sentWhileOpen = server.commands.length
    await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    expect(server.commands.length).toBe(sentWhileOpen)
    expect(store.stats.commands).toBe(3)
    expect(store.stats.errors).toBe(3)
    expect(store.stats.timeouts).toBe(0)

    await sleep(90)
    expect(await store.hgetall('k')).toBeNull()
    expect(store.stats.breakerOpenedAt).toBeNull()
    expect(store.stats.errors).toBe(3)
    expect(server.commands.length).toBe(sentWhileOpen + 1)
  })

  it('reopens the breaker when the half-open probe fails', async () => {
    const server = await startServer()
    const store = makeStore(server, { breakerMs: 60 })
    for (let attempt = 0; attempt < 3; attempt += 1) server.failNext('ERR down')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    }
    const openedAt = store.stats.breakerOpenedAt
    expect(openedAt).not.toBeNull()

    await sleep(90)
    server.failNext('ERR still down')
    await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    expect(store.stats.errors).toBe(4)
    expect(store.stats.breakerOpenedAt).toBeGreaterThan(openedAt as number)

    const sentAfterProbe = server.commands.length
    await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    expect(server.commands.length).toBe(sentAfterProbe)
  })

  it('reconnects on the next command after the server drops the connection', async () => {
    const server = await startServer()
    const store = makeStore(server)
    expect(await store.ping()).toBe(true)
    expect(server.connectionCount).toBe(1)

    server.disconnectAll()
    await waitFor(() => server.activeConnections === 0)
    await sleep(30)

    expect(await store.ping()).toBe(true)
    expect(server.connectionCount).toBe(2)
    expect(store.stats.errors).toBe(0)
    expect(store.stats.breakerOpenedAt).toBeNull()
  })

  it('rejects in-flight and queued commands on close and is idempotent', async () => {
    const server = await startServer({ delayMs: 200 })
    const store = makeStore(server)

    const inFlight = store.hgetall('k').catch((error: unknown) => error)
    const queued = store.hgetall('k').catch((error: unknown) => error)
    await server.waitForCommands(1)

    await store.close()
    expect(await inFlight).toBeInstanceOf(CacheUnavailableError)
    expect(await queued).toBeInstanceOf(CacheUnavailableError)
    expect(server.commands.filter((command) => command.name === 'HGETALL')).toHaveLength(1)

    await store.close()
    expect(await store.ping()).toBe(false)
    await expect(store.hgetall('k')).rejects.toBeInstanceOf(CacheUnavailableError)
    // Closing is not a cache failure, so it must not pollute the health metrics.
    expect(store.stats.errors).toBe(0)
    expect(store.stats.timeouts).toBe(0)
    expect(store.stats.commands).toBe(1)
  })
})

const redisSocketPath = process.env.PARSE_TEST_REDIS_SOCKET

function encodeRawCommand(args: readonly string[]): string {
  let payload = `*${args.length}\r\n`
  for (const arg of args) payload += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`
  return payload
}

/** Minimal single-reply RESP2 call, only for asserting PTTL in the gated test. */
function rawRedisCommand(
  socketPath: string,
  args: readonly string[],
): Promise<string | number | null> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath })
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('raw redis command timed out'))
    }, 2000)
    timer.unref?.()
    const finish = (error: Error | null, value?: string | number | null): void => {
      clearTimeout(timer)
      socket.destroy()
      if (error === null) resolve(value ?? null)
      else reject(error)
    }
    socket.setEncoding('utf8')
    socket.on('error', (error) => finish(error))
    socket.on('connect', () => socket.write(encodeRawCommand(args)))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\r\n')
      if (end === -1) return
      const line = buffer.slice(0, end)
      if (line.startsWith('-')) return finish(new Error(line.slice(1)))
      if (line.startsWith(':')) return finish(null, Number.parseInt(line.slice(1), 10))
      if (line.startsWith('+')) return finish(null, line.slice(1))
      finish(null, null)
    })
  })
}

describe.skipIf(redisSocketPath === undefined)('real redis (PARSE_TEST_REDIS_SOCKET)', () => {
  it('round-trips a hash and applies a positive TTL', async () => {
    const socketPath = redisSocketPath as string
    const store = createRedisCacheStore({ socketPath, db: 0 })
    try {
      expect(await store.ping()).toBe(true)
      const key = `genoffice:cache-test:${process.pid}:${Date.now()}`
      await store.hset(key, { document: '{"x":1}', count: '1' }, 60)
      expect(await store.hgetall(key)).toEqual({ document: '{"x":1}', count: '1' })

      const pttl = await rawRedisCommand(socketPath, ['PTTL', key])
      expect(typeof pttl).toBe('number')
      expect(pttl as number).toBeGreaterThan(0)
      expect(pttl as number).toBeLessThanOrEqual(60_000)

      await store.del([key])
      expect(await store.hgetall(key)).toBeNull()
    } finally {
      await store.close()
    }
  })
})
