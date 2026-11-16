import { expect, it } from 'vitest'
import { IdempotencyStore, readIdempotencyKey } from '../src/idempotency'
import type { IdempotencyEntry, IdempotencyStoreOptions } from '../src/idempotency'

/** Test clock: TTL behaviour must be asserted without sleeping. */
function fakeClock(start = 1000) {
  let current = start
  return {
    now: () => current,
    at: (time: number) => {
      current = time
    },
    advance: (ms: number) => {
      current += ms
    },
  }
}

function testKey(n: number): string {
  return 'idem-key-' + n.toString().padStart(4, '0')
}

function testEntry(
  status = 200,
  body: unknown = { ok: true },
): {
  status: number
  body: unknown
  headers: Record<string, string>
} {
  return { status, body, headers: { 'content-type': 'application/json' } }
}

function expectInvalidIdempotencyKey(run: () => unknown): void {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as { code?: string }).code).toBe('invalid_idempotency_key')
    return
  }
  throw new Error('expected invalid_idempotency_key')
}

it('replays a stored JSON response with its status, body and headers', () => {
  const clock = fakeClock(1234)
  const store = new IdempotencyStore({ now: clock.now })
  const headers = {
    Location: '/v1/sessions/s-1',
    'Retry-After': '1',
    'content-type': 'application/json',
  }
  expect(
    store.remember('v2:sessions', testKey(1), {
      status: 202,
      body: { sessionId: 's-1', state: 'pending' },
      headers,
    }),
  ).toBe(true)
  const replay = store.get('v2:sessions', testKey(1))
  expect(replay).toEqual({
    status: 202,
    body: { sessionId: 's-1', state: 'pending' },
    headers,
    createdAt: 1234,
  })
  // Each replay is a fresh copy: a caller cannot rewrite what the next retry sees.
  const replayEntry = replay as IdempotencyEntry
  const replayBody = replayEntry.body as { sessionId: string }
  replayBody.sessionId = 'changed'
  replayEntry.headers.Location = '/changed'
  expect(store.get('v2:sessions', testKey(1))?.body).toEqual({
    sessionId: 's-1',
    state: 'pending',
  })
  expect(store.get('v2:sessions', testKey(1))?.headers.Location).toBe('/v1/sessions/s-1')
})

it('expires entries after the default ten minute TTL without refreshing on reads', () => {
  const clock = fakeClock(0)
  const store = new IdempotencyStore({ now: clock.now })
  expect(store.remember('v2:sessions', testKey(1), testEntry(201))).toBe(true)
  clock.advance(599_999)
  expect(store.get('v2:sessions', testKey(1))).toBeDefined()
  // The read must not extend the fixed TTL window.
  clock.advance(1)
  expect(store.get('v2:sessions', testKey(1))).toBeUndefined()
  expect(store.stats()).toEqual({ entries: 0, hits: 1, misses: 1, evicted: 0, expired: 1 })
})

it('counts hits and misses on lookups of well-formed keys', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  expect(store.get('v2:sessions', testKey(1))).toBeUndefined()
  expect(store.stats()).toMatchObject({ entries: 0, hits: 0, misses: 1 })
  expect(store.remember('v2:sessions', testKey(1), testEntry())).toBe(true)
  expect(store.get('v2:sessions', testKey(1))).toBeDefined()
  expect(store.get('v2:sessions', testKey(1))).toBeDefined()
  expect(store.stats()).toMatchObject({ entries: 1, hits: 2, misses: 1 })
})

it('refuses to cache non-2xx statuses', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  for (const status of [100, 199, 300, 301, 404, 500, 599, 0]) {
    expect(store.remember('v2:sessions', testKey(1), testEntry(status))).toBe(false)
  }
  expect(store.remember('v2:sessions', testKey(1), testEntry(200.5))).toBe(false)
  expect(store.remember('v2:sessions', testKey(1), testEntry(Number.NaN))).toBe(false)
  expect(store.stats()).toMatchObject({ entries: 0, hits: 0, misses: 0 })
  for (const status of [200, 201, 202, 204, 299]) {
    expect(store.remember('v2:sessions', testKey(status), testEntry(status))).toBe(true)
  }
  expect(store.stats().entries).toBe(5)
})

it('caps replayed bodies at 64 KiB of UTF-8 JSON', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  const sized = (padLength: number) => ({ pad: 'x'.repeat(padLength) })
  // JSON.stringify({ pad: '' }) adds 10 framing bytes, so 65_526 pads to exactly 64 KiB.
  expect(store.remember('v2:sessions', testKey(1), testEntry(200, sized(65_526)))).toBe(true)
  expect(store.remember('v2:sessions', testKey(2), testEntry(200, sized(65_527)))).toBe(false)
  // Bytes, not characters: 22_000 CJK characters serialise to 66_000 bytes.
  const multibyte = { pad: '中'.repeat(22_000) }
  expect(store.remember('v2:sessions', testKey(3), testEntry(200, multibyte))).toBe(false)
  expect(store.stats().entries).toBe(1)
})

it('rejects bodies that JSON cannot represent', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  const bodies: unknown[] = [10n, () => 1, cyclic, Symbol('x')]
  for (const body of bodies) {
    expect(store.remember('v2:sessions', testKey(1), testEntry(200, body))).toBe(false)
  }
  // Top-level undefined is not JSON either; a defaulted helper would hide it.
  expect(
    store.remember('v2:sessions', testKey(1), { status: 200, body: undefined, headers: {} }),
  ).toBe(false)
  expect(store.stats().entries).toBe(0)
})

it('rejects header values that could inject response lines', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  const unsafe: Record<string, string>[] = [
    { Location: '/v1/sessions/1\r\nX-Injected: 1' },
    { Location: '/v1/sessions/1\nX-Injected: 1' },
    { 'Retry-After': '1\r' },
  ]
  for (const headers of unsafe) {
    const entry = { status: 200, body: {}, headers }
    expect(store.remember('v2:sessions', testKey(1), entry)).toBe(false)
  }
  const notStrings = [
    { 'Retry-After': 1 },
    { 'Retry-After': undefined },
    { 'Retry-After': null },
  ] as unknown as Record<string, string>[]
  for (const headers of notStrings) {
    const entry = { status: 200, body: {}, headers }
    expect(store.remember('v2:sessions', testKey(1), entry)).toBe(false)
  }
  expect(
    store.remember('v2:sessions', testKey(1), {
      status: 200,
      body: {},
      headers: [] as unknown as Record<string, string>,
    }),
  ).toBe(false)
  expect(store.stats().entries).toBe(0)
  expect(
    store.remember('v2:sessions', testKey(2), {
      status: 200,
      body: {},
      headers: { Location: '/v1/sessions/2', 'Retry-After': '1' },
    }),
  ).toBe(true)
})

it('rejects malformed scopes and keys without throwing', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  for (const scope of ['', 'Sessions', 'v2 sessions', 'v2/sessions', 'a'.repeat(65)]) {
    expect(store.remember(scope, testKey(1), testEntry())).toBe(false)
    expect(store.get(scope, testKey(1))).toBeUndefined()
  }
  for (const key of ['', 'short', 'a'.repeat(129), 'bad key 0001', 'bad/key/0001', 'idem-key-1 ']) {
    expect(store.remember('v2:sessions', key, testEntry())).toBe(false)
    expect(store.get('v2:sessions', key)).toBeUndefined()
  }
  // Malformed lookups are not misses on a valid key, so the counters stay put.
  expect(store.stats()).toMatchObject({ hits: 0, misses: 0 })
  expect(store.remember('a'.repeat(64), 'a'.repeat(8), testEntry())).toBe(true)
})

it('replaces the response on a repeated scope+key', () => {
  const clock = fakeClock(1000)
  const store = new IdempotencyStore({ now: clock.now })
  expect(store.remember('v2:sessions', testKey(1), testEntry(201, { version: 1 }))).toBe(true)
  clock.at(2000)
  expect(store.remember('v2:sessions', testKey(1), testEntry(202, { version: 2 }))).toBe(true)
  expect(store.get('v2:sessions', testKey(1))).toEqual({
    status: 202,
    body: { version: 2 },
    headers: { 'content-type': 'application/json' },
    createdAt: 2000,
  })
  expect(store.stats()).toMatchObject({ entries: 1, evicted: 0 })
})

it('evicts the oldest entries first when maxEntries is full', () => {
  const clock = fakeClock(1000)
  const store = new IdempotencyStore({ now: clock.now, maxEntries: 2 })
  expect(store.remember('v2:sessions', testKey(1), testEntry())).toBe(true)
  clock.advance(1000)
  expect(store.remember('v2:sessions', testKey(2), testEntry())).toBe(true)
  clock.advance(1000)
  expect(store.remember('v2:sessions', testKey(3), testEntry())).toBe(true)
  expect(store.stats()).toMatchObject({ entries: 2, evicted: 1 })
  expect(store.get('v2:sessions', testKey(1))).toBeUndefined()
  expect(store.get('v2:sessions', testKey(2))).toBeDefined()
  expect(store.get('v2:sessions', testKey(3))).toBeDefined()
  // Overwriting refreshes createdAt without consuming a slot.
  clock.advance(1000)
  expect(store.remember('v2:sessions', testKey(2), testEntry())).toBe(true)
  expect(store.stats()).toMatchObject({ entries: 2, evicted: 1 })
  clock.advance(1000)
  expect(store.remember('v2:sessions', testKey(4), testEntry())).toBe(true)
  expect(store.get('v2:sessions', testKey(3))).toBeUndefined()
  expect(store.get('v2:sessions', testKey(2))).toBeDefined()
  expect(store.get('v2:sessions', testKey(4))).toBeDefined()
  expect(store.stats()).toMatchObject({ entries: 2, evicted: 2 })
})

it('defaults to a bounded 256 entry store', () => {
  const clock = fakeClock(0)
  const store = new IdempotencyStore({ now: clock.now })
  for (let index = 0; index < 257; index++) {
    clock.at(index)
    expect(store.remember('v2:sessions', testKey(index), testEntry())).toBe(true)
  }
  expect(store.stats()).toEqual({ entries: 256, hits: 0, misses: 0, evicted: 1, expired: 0 })
  expect(store.get('v2:sessions', testKey(0))).toBeUndefined()
})

it('reports lazy TTL pruning and capacity eviction in stats', () => {
  const clock = fakeClock(0)
  const store = new IdempotencyStore({ now: clock.now, ttlMs: 100, maxEntries: 2 })
  expect(store.stats()).toEqual({ entries: 0, hits: 0, misses: 0, evicted: 0, expired: 0 })
  expect(store.remember('v2:sessions', testKey(1), testEntry())).toBe(true)
  clock.at(50)
  expect(store.remember('v2:sessions', testKey(2), testEntry())).toBe(true)
  expect(store.get('v2:sessions', testKey(1))).toBeDefined()
  clock.at(100)
  expect(store.get('v2:sessions', testKey(1))).toBeUndefined()
  expect(store.stats()).toMatchObject({ entries: 1, hits: 1, misses: 1, expired: 1 })
  clock.at(200)
  expect(store.remember('v2:sessions', testKey(3), testEntry())).toBe(true)
  expect(store.stats()).toMatchObject({ entries: 1, expired: 2 })
  expect(store.remember('v2:sessions', testKey(4), testEntry())).toBe(true)
  expect(store.remember('v2:sessions', testKey(5), testEntry())).toBe(true)
  expect(store.stats()).toMatchObject({ entries: 2, evicted: 1 })
})

it('stops serving after close without throwing', () => {
  const clock = fakeClock()
  const store = new IdempotencyStore({ now: clock.now })
  expect(store.remember('v2:sessions', testKey(1), testEntry())).toBe(true)
  expect(store.get('v2:sessions', testKey(1))).toBeDefined()
  store.close()
  expect(store.get('v2:sessions', testKey(1))).toBeUndefined()
  expect(store.remember('v2:sessions', testKey(2), testEntry())).toBe(false)
  expect(store.stats()).toEqual({ entries: 0, hits: 1, misses: 0, evicted: 0, expired: 0 })
  expect(() => store.close()).not.toThrow()
  expect(store.get('v2:sessions', testKey(1))).toBeUndefined()
})

it('validates constructor options', () => {
  const invalid: IdempotencyStoreOptions[] = [
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: 1.5 },
    { ttlMs: Number.NaN },
    { ttlMs: 2_147_483_648 },
    { maxEntries: 0 },
    { maxEntries: 100_001 },
    { maxEntries: 2.5 },
    { now: 1 as unknown as () => number },
    { now: 'clock' as unknown as () => number },
  ]
  for (const options of invalid) {
    expect(() => new IdempotencyStore(options)).toThrow('invalid idempotency configuration')
  }
  expect(() => new IdempotencyStore(null as unknown as IdempotencyStoreOptions)).toThrow(
    'invalid idempotency configuration',
  )
  expect(new IdempotencyStore()).toBeInstanceOf(IdempotencyStore)
  expect(new IdempotencyStore({ ttlMs: 1, maxEntries: 99_999, now: () => 5 })).toBeInstanceOf(
    IdempotencyStore,
  )
})

it('reads the Idempotency-Key header', () => {
  expect(readIdempotencyKey({})).toBeUndefined()
  expect(readIdempotencyKey({ 'idempotency-key': 'idem-key-0001' })).toBe('idem-key-0001')
  expect(readIdempotencyKey({ 'idempotency-key': ['idem-key-0001'] })).toBe('idem-key-0001')
  expect(readIdempotencyKey({ 'idempotency-key': [] })).toBeUndefined()
  for (const key of ['a'.repeat(8), 'a'.repeat(128)]) {
    expect(readIdempotencyKey({ 'idempotency-key': key })).toBe(key)
  }
})

it('rejects malformed Idempotency-Key headers with a coded error', () => {
  const malformed: Array<string | string[]> = [
    '',
    'short',
    'a'.repeat(129),
    'idem key 0001',
    'idem/key/0001',
    'idem-key-1 ',
    ['idem-key-0001', 'idem-key-0002'],
  ]
  for (const value of malformed) {
    expectInvalidIdempotencyKey(() => readIdempotencyKey({ 'idempotency-key': value }))
  }
  expectInvalidIdempotencyKey(() =>
    readIdempotencyKey({ 'idempotency-key': [1, 2] as unknown as string[] }),
  )
  expectInvalidIdempotencyKey(() =>
    readIdempotencyKey({ 'idempotency-key': 42 as unknown as string }),
  )
})
