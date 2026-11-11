import { createConnection, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import {
  CACHE_DEFAULTS,
  CacheUnavailableError,
  type CacheClientStats,
  type HotCacheStore,
  type RedisCacheConfig,
} from './cache-contract'

/**
 * Minimal RESP2 hot-cache client (plan §5.1, P3.5).
 *
 * The store is a best-effort projection: every failure rejects with
 * `CacheUnavailableError` and is counted in `stats`, never thrown as a process
 * error and never retried. The HTTP layer decides to degrade (serve from MySQL
 * or report pending); nothing here can make a request fail with 5xx on its own.
 *
 * One connection, one command in flight, no reconnects in the middle of a
 * command: a timeout destroys the socket so the next command starts clean.
 */

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 6379
const MAX_RESP_DEPTH = 32
const MAX_RESP_BUFFER_BYTES = 64 * 1024 * 1024
const BREAKER_FAILURE_THRESHOLD = 3

export interface RedisCacheStoreOptions {
  /** Budget for one command (connect + handshake included); defaults to 80 ms. */
  timeoutMs?: number
  /** How long the breaker stays open before a half-open probe; defaults to 5 s. */
  breakerMs?: number
  /** Injectable clock for breaker tests. */
  now?: () => number
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') return undefined
  return value
}

function integerSetting(name: string, raw: string, min: number, max: number): number {
  const text = raw.trim()
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function booleanSetting(name: string, raw: string): boolean {
  const text = raw.trim().toLowerCase()
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false
  throw new Error(`${name} must be one of 1/0/true/false/yes/no/on/off`)
}

/**
 * Read the optional Redis settings (same level as `mysql`). Returns null when no
 * `REDIS_*` variable is set, which keeps `mode=memory` the default.
 */
export function redisConfigFromEnv(): RedisCacheConfig | null {
  const host = readEnv('REDIS_HOST')
  const port = readEnv('REDIS_PORT')
  const socketPath = readEnv('REDIS_SOCKET')
  const username = readEnv('REDIS_USERNAME')
  const password = readEnv('REDIS_PASSWORD')
  const db = readEnv('REDIS_DB')
  const tls = readEnv('REDIS_TLS')
  if (
    host === undefined &&
    port === undefined &&
    socketPath === undefined &&
    username === undefined &&
    password === undefined &&
    db === undefined &&
    tls === undefined
  )
    return null

  const config: RedisCacheConfig = {}
  if (socketPath !== undefined) {
    // The unix socket takes precedence; TLS is only meaningful for TCP.
    config.socketPath = socketPath
  } else {
    config.host = host ?? DEFAULT_HOST
    config.port = port === undefined ? DEFAULT_PORT : integerSetting('REDIS_PORT', port, 1, 65535)
  }
  if (username !== undefined) config.username = username
  if (password !== undefined) config.password = password
  if (db !== undefined) config.db = integerSetting('REDIS_DB', db, 0, 65535)
  if (tls !== undefined) config.tls = booleanSetting('REDIS_TLS', tls)
  return config
}

/** A server error reply (`-ERR ...`), kept as a value so pipelines can inspect it. */
class RespErrorReply {
  constructor(readonly message: string) {}
}

type RespValue = string | number | null | RespValue[] | RespErrorReply

interface ParsedReply {
  done: true
  value: RespValue
  next: number
}

type ParseResult = ParsedReply | { done: false }

function readLine(buffer: Buffer, offset: number): { line: string; next: number } | null {
  const end = buffer.indexOf('\r\n', offset)
  if (end === -1) return null
  return { line: buffer.toString('utf8', offset, end), next: end + 2 }
}

function parseReply(buffer: Buffer, offset: number, depth = 0): ParseResult {
  if (depth > MAX_RESP_DEPTH) throw new Error('RESP nesting is too deep')
  if (offset >= buffer.length) return { done: false }
  const type = buffer[offset]
  const header = readLine(buffer, offset + 1)
  if (header === null) return { done: false }
  if (type === 0x2b) return { done: true, value: header.line, next: header.next } // +simple
  if (type === 0x2d)
    return { done: true, value: new RespErrorReply(header.line), next: header.next } // -error
  if (type === 0x3a) {
    // :integer
    const value = Number.parseInt(header.line, 10)
    if (!Number.isSafeInteger(value)) throw new Error('invalid RESP integer')
    return { done: true, value, next: header.next }
  }
  if (type === 0x24) {
    // $bulk
    const length = Number.parseInt(header.line, 10)
    if (length === -1) return { done: true, value: null, next: header.next }
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('invalid RESP bulk length')
    const end = header.next + length
    if (buffer.length < end + 2) return { done: false }
    if (buffer[end] !== 0x0d || buffer[end + 1] !== 0x0a) throw new Error('invalid RESP bulk frame')
    return { done: true, value: buffer.toString('utf8', header.next, end), next: end + 2 }
  }
  if (type === 0x2a) {
    // *array
    const count = Number.parseInt(header.line, 10)
    if (count === -1) return { done: true, value: null, next: header.next }
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid RESP array length')
    const values: RespValue[] = []
    let next = header.next
    for (let index = 0; index < count; index += 1) {
      const item = parseReply(buffer, next, depth + 1)
      if (!item.done) return { done: false }
      values.push(item.value)
      next = item.next
    }
    return { done: true, value: values, next }
  }
  throw new Error(`unsupported RESP type byte 0x${type.toString(16)}`)
}

/** Incremental RESP2 decoder: feeds complete replies as soon as their bytes arrive. */
class RespParser {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): RespValue[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_RESP_BUFFER_BYTES) throw new Error('redis reply is too large')
    const replies: RespValue[] = []
    let offset = 0
    for (;;) {
      const parsed = parseReply(this.buffer, offset)
      if (!parsed.done) break
      replies.push(parsed.value)
      offset = parsed.next
    }
    this.buffer = offset === 0 ? this.buffer : this.buffer.subarray(offset)
    return replies
  }
}

function encodeCommand(args: readonly string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`)]
  for (const arg of args) {
    const value = Buffer.from(arg, 'utf8')
    chunks.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'))
  }
  return Buffer.concat(chunks)
}

function ensureNoReplyErrors(replies: readonly RespValue[]): void {
  for (const reply of replies) {
    if (reply instanceof RespErrorReply)
      throw new CacheUnavailableError(`redis error: ${reply.message}`)
  }
}

function hashReplyToRecord(reply: RespValue): Record<string, string> | null {
  if (reply === null) return null
  if (!Array.isArray(reply) || reply.length % 2 !== 0)
    throw new CacheUnavailableError('invalid HGETALL reply')
  if (reply.length === 0) return null
  const record: Record<string, string> = {}
  for (let index = 0; index < reply.length; index += 2) {
    const field = reply[index]
    const value = reply[index + 1]
    if (typeof field !== 'string' || typeof value !== 'string')
      throw new CacheUnavailableError('invalid HGETALL reply')
    record[field] = value
  }
  return record
}

/** Timeouts and close-triggered rejections are not counted as cache errors. */
class CacheTimeoutError extends CacheUnavailableError {}

class CacheClosedError extends CacheUnavailableError {}

interface PendingRequest {
  remaining: number
  replies: RespValue[]
  resolve: (replies: RespValue[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

/** One socket, strictly one command in flight. */
class RespConnection {
  /** Set by the store so it can drop the reference once the socket is gone. */
  onClosed: () => void = () => {}
  private readonly socket: Socket
  private readonly parser = new RespParser()
  private pending: PendingRequest[] = []
  private closed = false

  constructor(
    socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', (error: Error) => {
      this.destroy(new CacheUnavailableError('redis connection error', { cause: error }))
    })
    socket.on('close', () => {
      this.destroy(new CacheUnavailableError('redis connection closed'))
    })
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed
  }

  get writable(): boolean {
    return !this.isClosed && this.socket.writable
  }

  /** Write a pipeline and resolve with exactly one reply per command. */
  send(commands: readonly (readonly string[])[], timeoutMs = this.timeoutMs): Promise<RespValue[]> {
    if (!this.writable) return Promise.reject(new CacheUnavailableError('redis connection closed'))
    if (commands.length === 0) return Promise.resolve([])
    const payload = Buffer.concat(commands.map((args) => encodeCommand(args)))
    return new Promise<RespValue[]>((resolve, reject) => {
      const request: PendingRequest = {
        remaining: commands.length,
        replies: [],
        resolve,
        reject,
        timer: undefined,
      }
      request.timer = setTimeout(
        () => {
          this.destroy(new CacheTimeoutError('redis command timed out'))
        },
        Math.max(1, timeoutMs),
      )
      request.timer.unref?.()
      this.pending.push(request)
      this.socket.write(payload, (error?: Error | null) => {
        if (error) this.destroy(new CacheUnavailableError('redis write failed', { cause: error }))
      })
    })
  }

  destroy(reason?: Error): void {
    if (this.closed) return
    this.closed = true
    const failure = reason ?? new CacheUnavailableError('redis connection closed')
    const pending = this.pending
    this.pending = []
    for (const request of pending) {
      if (request.timer !== undefined) clearTimeout(request.timer)
      request.reject(failure)
    }
    this.socket.destroy()
    this.onClosed()
  }

  private onData(chunk: Buffer): void {
    let replies: RespValue[]
    try {
      replies = this.parser.push(chunk)
    } catch (error) {
      this.destroy(new CacheUnavailableError('invalid redis reply', { cause: error }))
      return
    }
    for (const reply of replies) {
      const request = this.pending[0]
      if (request === undefined) {
        // No command awaiting this reply: the stream is out of sync, drop it.
        this.destroy(new CacheUnavailableError('unexpected redis reply'))
        return
      }
      request.replies.push(reply)
      request.remaining -= 1
      if (request.remaining > 0) continue
      this.pending.shift()
      if (request.timer !== undefined) clearTimeout(request.timer)
      request.resolve(request.replies)
    }
  }
}

function waitForConnect(socket: Socket, useTls: boolean, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.off('error', onError)
      socket.off('close', onClose)
      if (useTls) socket.off('secureConnect', onConnect)
      else socket.off('connect', onConnect)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onError = (error: Error): void => {
      finish(new CacheUnavailableError('redis connect failed', { cause: error }))
    }
    const onClose = (): void => {
      finish(new CacheUnavailableError('redis connection closed while connecting'))
    }
    const onConnect = (): void => finish()
    const timer = setTimeout(() => {
      finish(new CacheTimeoutError('redis connect timed out'))
    }, timeoutMs)
    timer.unref?.()
    socket.on('error', onError)
    socket.on('close', onClose)
    if (useTls) socket.once('secureConnect', onConnect)
    else socket.once('connect', onConnect)
  })
}

/**
 * Build the optional Redis-backed store. The returned store is lazy: no socket
 * is opened until the first command, and every failure is reported through
 * `stats` instead of escaping as an unhandled rejection.
 */
export function createRedisCacheStore(
  config: RedisCacheConfig,
  options: RedisCacheStoreOptions = {},
): HotCacheStore {
  const timeoutMs = options.timeoutMs ?? CACHE_DEFAULTS.commandTimeoutMs
  const breakerMs = options.breakerMs ?? CACHE_DEFAULTS.breakerMs
  const now = options.now ?? Date.now
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error('timeoutMs must be a positive integer')
  if (!Number.isSafeInteger(breakerMs) || breakerMs < 0)
    throw new Error('breakerMs must be a non-negative integer')
  if (
    config.port !== undefined &&
    (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535)
  )
    throw new Error('port must be an integer between 1 and 65535')
  if (
    config.db !== undefined &&
    (!Number.isSafeInteger(config.db) || config.db < 0 || config.db > 65535)
  )
    throw new Error('db must be an integer between 0 and 65535')

  const stats: CacheClientStats = {
    commands: 0,
    errors: 0,
    timeouts: 0,
    lastErrorAt: null,
    breakerOpenedAt: null,
  }
  let consecutiveFailures = 0
  let halfOpen = false
  let closed = false
  let connection: RespConnection | null = null
  let tail: Promise<unknown> = Promise.resolve()

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new CacheClosedError('hot cache is closed'))
    const result = tail.then(work, work)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function admit(): boolean {
    if (stats.breakerOpenedAt === null) return true
    if (now() - stats.breakerOpenedAt < breakerMs) return false
    if (halfOpen) return false
    // Half-open: exactly one probe may pass, the rest keep failing fast.
    halfOpen = true
    return true
  }

  function succeed(): void {
    consecutiveFailures = 0
    halfOpen = false
    stats.breakerOpenedAt = null
  }

  function recordFailure(): void {
    consecutiveFailures += 1
    halfOpen = false
    if (consecutiveFailures >= BREAKER_FAILURE_THRESHOLD) stats.breakerOpenedAt = now()
  }

  function remainingMs(deadline: number): number {
    return Math.max(1, deadline - Date.now())
  }

  async function openConnection(deadline: number): Promise<RespConnection> {
    const useTls = config.tls === true && config.socketPath === undefined
    const host = config.host ?? DEFAULT_HOST
    const port = config.port ?? DEFAULT_PORT
    const socket = useTls
      ? connectTls({ host, port })
      : config.socketPath !== undefined
        ? createConnection({ path: config.socketPath })
        : createConnection({ host, port })
    const opened = new RespConnection(socket, timeoutMs)
    opened.onClosed = () => {
      if (connection === opened) connection = null
    }
    try {
      await waitForConnect(socket, useTls, remainingMs(deadline))
      const handshake: string[][] = []
      if (config.password !== undefined) {
        handshake.push(
          config.username === undefined
            ? ['AUTH', config.password]
            : ['AUTH', config.username, config.password],
        )
      }
      if (config.db !== undefined) handshake.push(['SELECT', String(config.db)])
      if (handshake.length > 0)
        ensureNoReplyErrors(await opened.send(handshake, remainingMs(deadline)))
      return opened
    } catch (error) {
      opened.destroy()
      throw error
    }
  }

  async function ensureConnection(deadline: number): Promise<RespConnection> {
    if (connection !== null && connection.writable) return connection
    if (connection !== null) {
      connection.destroy()
      connection = null
    }
    const opened = await openConnection(deadline)
    if (closed) {
      opened.destroy(new CacheClosedError('hot cache is closed'))
      throw new CacheClosedError('hot cache is closed')
    }
    connection = opened
    return opened
  }

  function execute<T>(
    work: (connection: RespConnection, deadline: number) => Promise<T>,
  ): Promise<T> {
    // The budget is fixed when the caller joins the queue, so a burst of polls
    // cannot extend a request past its single 50–100 ms allowance.
    const deadline = Date.now() + timeoutMs
    return enqueue(async () => {
      if (closed) throw new CacheClosedError('hot cache is closed')
      if (!admit()) throw new CacheUnavailableError('hot cache breaker is open')
      stats.commands += 1
      try {
        const opened = await ensureConnection(deadline)
        const value = await work(opened, deadline)
        succeed()
        return value
      } catch (error) {
        const unavailable =
          error instanceof CacheUnavailableError
            ? error
            : new CacheUnavailableError('redis command failed', { cause: error })
        if (unavailable instanceof CacheClosedError) {
          halfOpen = false
        } else {
          stats.errors += 1
          stats.lastErrorAt = now()
          if (unavailable instanceof CacheTimeoutError) stats.timeouts += 1
          recordFailure()
        }
        throw unavailable
      }
    })
  }

  function assertKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0)
      throw new Error('cache key must be a non-empty string')
  }

  async function hset(
    key: string,
    values: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void> {
    assertKey(key)
    const fields = Object.entries(values)
    if (fields.length === 0) throw new Error('values must contain at least one field')
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0)
      throw new Error('ttlSeconds must be a positive integer')
    const command = ['HSET', key]
    for (const [field, value] of fields) command.push(field, String(value))
    await execute(async (opened, deadline) => {
      // One write, two replies: HSET then EXPIRE keeps the TTL on the same frame
      // that creates the hash, so a lost EXPIRE can never leave a hash forever.
      const replies = await opened.send(
        [command, ['EXPIRE', key, String(ttlSeconds)]],
        remainingMs(deadline),
      )
      ensureNoReplyErrors(replies)
    })
  }

  async function hgetall(key: string): Promise<Record<string, string> | null> {
    assertKey(key)
    return execute(async (opened, deadline) => {
      const [reply] = await opened.send([['HGETALL', key]], remainingMs(deadline))
      ensureNoReplyErrors([reply])
      return hashReplyToRecord(reply)
    })
  }

  async function del(keys: readonly string[]): Promise<void> {
    for (const key of keys) assertKey(key)
    if (keys.length === 0) return
    await execute(async (opened, deadline) => {
      ensureNoReplyErrors(await opened.send([['DEL', ...keys]], remainingMs(deadline)))
    })
  }

  async function ping(): Promise<boolean> {
    try {
      const [reply] = await execute((opened, deadline) =>
        opened.send([['PING']], remainingMs(deadline)),
      )
      return reply === 'PONG'
    } catch {
      return false
    }
  }

  async function close(): Promise<void> {
    closed = true
    const opened = connection
    connection = null
    opened?.destroy(new CacheClosedError('hot cache is closed'))
  }

  return {
    get stats(): CacheClientStats {
      return { ...stats }
    },
    hset,
    hgetall,
    del,
    ping,
    close,
  }
}
