/**
 * Bounded, in-process idempotency cache for replayable v2 POST responses.
 *
 * Replays never leave the process: this store is a memory aid for clients that
 * retry, not a shared ledger, so a duplicate that lands on another node still
 * runs the request. Only JSON bodies are cacheable — a stream cannot be replayed
 * from memory — and the handler must hand over the body it is about to send.
 *
 * Both limits are hard: entries expire after `ttlMs` (10 minutes by default) and
 * capacity is capped at `maxEntries` (256 by default) with oldest-first
 * eviction, so a retry storm cannot grow the process without bound. Reads never
 * extend an entry's TTL: a response is replayable for a fixed window.
 */

const SCOPE_PATTERN = /^[a-z0-9:_-]{1,64}$/
const KEY_PATTERN = /^[A-Za-z0-9._:-]+$/
const KEY_MIN_LENGTH = 8
const KEY_MAX_LENGTH = 128
const DEFAULT_TTL_MS = 10 * 60_000
const DEFAULT_MAX_ENTRIES = 256
const MAX_TTL_MS = 2_147_483_647
const MAX_MAX_ENTRIES = 100_000
/** Largest replayed JSON body; in-memory replays must stay small. */
const MAX_BODY_BYTES = 64 * 1024
const CONFIG_ERROR = 'invalid idempotency configuration'

export interface IdempotencyEntry {
  status: number
  /** JSON-serializable response body (never a stream). */
  body: unknown
  /** Response headers to replay (Location/Retry-After/content-type). */
  headers: Record<string, string>
  createdAt: number
}

export interface IdempotencyStoreOptions {
  /** Default 10 minutes; entries older than this are pruned. */
  ttlMs?: number
  /** Default 256; bounded memory, oldest-first eviction. */
  maxEntries?: number
  now?: () => number
}

/** Stored form: the body is kept as canonical JSON text so replays are copies. */
interface StoredEntry {
  readonly status: number
  readonly bodyJson: string
  readonly headers: Record<string, string>
  readonly createdAt: number
}

type IdempotencyKeyError = Error & { code: 'invalid_idempotency_key' }

function invalidKey(message: string): IdempotencyKeyError {
  const error = new Error(message) as IdempotencyKeyError
  error.name = 'IdempotencyKeyError'
  error.code = 'invalid_idempotency_key'
  return error
}

function isValidScope(scope: unknown): scope is string {
  return typeof scope === 'string' && SCOPE_PATTERN.test(scope)
}

function isValidKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length >= KEY_MIN_LENGTH &&
    key.length <= KEY_MAX_LENGTH &&
    KEY_PATTERN.test(key)
  )
}

/** Neither pattern allows NUL, so the separator cannot be forged by a caller. */
function storageKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse the IDempotency-Key request header.
 *
 * Node exposes a single header as a string and only repeated headers as an
 * array; one array element is still a single value (take it), while several
 * values are ambiguous and rejected. Malformed values throw an Error whose
 * `code` is 'invalid_idempotency_key' so the HTTP layer can answer 400.
 */
export function readIdempotencyKey(headers: {
  'idempotency-key'?: string | string[]
}): string | undefined {
  const raw = headers['idempotency-key']
  if (raw === undefined) return undefined
  let value: string
  if (typeof raw === 'string') {
    value = raw
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) return undefined
    if (raw.length > 1) throw invalidKey('Idempotency-Key was provided more than once')
    const first = raw[0]
    if (typeof first !== 'string') throw invalidKey('Idempotency-Key must be a string')
    value = first
  } else {
    throw invalidKey('Idempotency-Key must be a string')
  }
  if (value.length === 0) throw invalidKey('Idempotency-Key must not be empty')
  if (!isValidKey(value))
    throw invalidKey(
      `Idempotency-Key must be ${KEY_MIN_LENGTH}-${KEY_MAX_LENGTH} characters of [A-Za-z0-9._:-]`,
    )
  return value
}

export class IdempotencyStore {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly entries = new Map<string, StoredEntry>()
  private hits = 0
  private misses = 0
  private evicted = 0
  private expired = 0
  private closed = false

  constructor(options: IdempotencyStoreOptions = {}) {
    if (typeof options !== 'object' || options === null || Array.isArray(options))
      throw new Error(CONFIG_ERROR)
    const { ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, now = Date.now } = options
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS)
      throw new Error(CONFIG_ERROR)
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_MAX_ENTRIES)
      throw new Error(CONFIG_ERROR)
    if (typeof now !== 'function') throw new Error(CONFIG_ERROR)
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.now = now
  }

  /** Return a non-expired stored response, counting hit/miss. */
  get(scope: string, key: string): IdempotencyEntry | undefined {
    if (this.closed) return undefined
    // A malformed lookup can never address a stored entry, and is not a cache
    // miss on a valid key: leave the counters untouched.
    if (!isValidScope(scope) || !isValidKey(key)) return undefined
    this.pruneExpired()
    const stored = this.entries.get(storageKey(scope, key))
    if (!stored) {
      this.misses++
      return undefined
    }
    this.hits++
    // Each replay gets a fresh body parse and header copy; callers cannot
    // mutate what later replays will serve.
    return {
      status: stored.status,
      body: JSON.parse(stored.bodyJson),
      headers: { ...stored.headers },
      createdAt: stored.createdAt,
    }
  }

  /** Store a JSON response; validates and prunes. Returns false when it cannot be stored. */
  remember(scope: string, key: string, entry: Omit<IdempotencyEntry, 'createdAt'>): boolean {
    if (this.closed) return false
    if (!isValidScope(scope) || !isValidKey(key)) return false
    if (!isPlainObject(entry)) return false
    const { status, body, headers } = entry
    // Only successful responses are replayable; errors and redirects are not.
    if (!Number.isSafeInteger(status) || status < 200 || status > 299) return false
    if (!isPlainObject(headers)) return false
    const replayHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) {
      // Node would reject these at write time anyway, but failing here keeps
      // header injection out of the stored replay.
      if (typeof value !== 'string' || /[\r\n]/.test(value)) return false
      replayHeaders[name] = value
    }
    let bodyJson: string | undefined
    try {
      bodyJson = JSON.stringify(body)
    } catch {
      return false
    }
    // undefined (functions, symbols, top-level undefined) and oversized bodies
    // are not replayable JSON.
    if (typeof bodyJson !== 'string') return false
    if (Buffer.byteLength(bodyJson, 'utf8') > MAX_BODY_BYTES) return false
    const createdAt = this.now()
    if (!Number.isFinite(createdAt)) return false
    this.pruneExpired()
    const mapKey = storageKey(scope, key)
    // Re-remembering the same scope+key replaces the old response; delete first
    // so the entry moves to the newest insertion position.
    this.entries.delete(mapKey)
    this.entries.set(mapKey, { status, bodyJson, headers: replayHeaders, createdAt })
    while (this.entries.size > this.maxEntries) this.evictOldest()
    return true
  }

  stats(): { entries: number; hits: number; misses: number; evicted: number; expired: number } {
    if (!this.closed) this.pruneExpired()
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evicted: this.evicted,
      expired: this.expired,
    }
  }

  close(): void {
    this.closed = true
    this.entries.clear()
  }

  /** Drop every entry whose fixed TTL has elapsed; bounded by `maxEntries`. */
  private pruneExpired(): void {
    const now = this.now()
    for (const [mapKey, stored] of this.entries) {
      if (now - stored.createdAt < this.ttlMs) continue
      this.entries.delete(mapKey)
      this.expired++
    }
  }

  /** Oldest `createdAt` first; insertion order breaks ties deterministically. */
  private evictOldest(): void {
    let oldestKey: string | undefined
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [mapKey, stored] of this.entries) {
      if (stored.createdAt < oldestAt) {
        oldestAt = stored.createdAt
        oldestKey = mapKey
      }
    }
    if (oldestKey === undefined) return
    this.entries.delete(oldestKey)
    this.evicted++
  }
}
