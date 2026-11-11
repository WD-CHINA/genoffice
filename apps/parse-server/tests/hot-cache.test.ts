import { afterEach, describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/artifact-store'
import { PreviewRegistry, type BuildPreviewEvent } from '../src/artifact-preview'
import { CACHE_DEFAULTS } from '../src/cache-contract'
import type { CacheClientStats, CacheMode, HotCache, HotCacheOptions, HotCacheStore } from '../src/cache-contract'
import { createHotCache } from '../src/hot-cache'

const PREFIX = 'genoffice:test:'
const ARTIFACT_KEY = 'a'.repeat(64)
const JOB_ID = 'deadbeef-0001'
const OTHER_JOB_ID = 'deadbeef-0002'
const pvKey = (jobId = JOB_ID) => PREFIX + 'pv:' + ARTIFACT_KEY + ':' + jobId
const jobKey = (jobId = JOB_ID) => PREFIX + 'job:' + jobId
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const settle = () => sleep(0)

const openCaches: HotCache[] = []
afterEach(async () => {
  await Promise.all(openCaches.splice(0).map((hot) => hot.close().catch(() => undefined)))
})

interface JournalEntry {
  command: 'hset' | 'hgetall' | 'del' | 'ping' | 'close'
  key?: string
  keys?: string[]
  values?: Record<string, string>
  ttlSeconds?: number
}

/** In-memory HotCacheStore with command journaling and fault injection. */
class FakeStore implements HotCacheStore {
  readonly stats: CacheClientStats = {
    commands: 0,
    errors: 0,
    timeouts: 0,
    lastErrorAt: null,
    breakerOpenedAt: null,
  }
  readonly hashes = new Map<string, Record<string, string>>()
  readonly ttls = new Map<string, number>()
  readonly journal: JournalEntry[] = []
  failHset: Error | undefined
  failHgetall: Error | undefined
  failDel: Error | undefined
  delayMs = 0
  closed = false

  private async pause(): Promise<void> {
    if (this.delayMs > 0) await sleep(this.delayMs)
  }

  async hset(key: string, values: Record<string, string>, ttlSeconds: number): Promise<void> {
    this.stats.commands++
    this.journal.push({ command: 'hset', key, values: { ...values }, ttlSeconds })
    await this.pause()
    if (this.failHset) throw this.failHset
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...values })
    this.ttls.set(key, ttlSeconds)
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    this.stats.commands++
    this.journal.push({ command: 'hgetall', key })
    await this.pause()
    if (this.failHgetall) throw this.failHgetall
    const hash = this.hashes.get(key)
    return hash ? { ...hash } : null
  }

  async del(keys: readonly string[]): Promise<void> {
    this.stats.commands++
    this.journal.push({ command: 'del', keys: [...keys] })
    await this.pause()
    if (this.failDel) throw this.failDel
    for (const key of keys) {
      this.hashes.delete(key)
      this.ttls.delete(key)
    }
  }

  async ping(): Promise<boolean> {
    this.stats.commands++
    this.journal.push({ command: 'ping' })
    return true
  }

  async close(): Promise<void> {
    this.journal.push({ command: 'close' })
    this.closed = true
  }

  hsetEntries(key: string): JournalEntry[] {
    return this.journal.filter((entry) => entry.command === 'hset' && entry.key === key)
  }
}

const document = (unitCount = 3) => ({
  type: 'document' as const,
  format: 'pptx' as const,
  unitCount,
  document: { model: { format: 'pptx', unitCount, unitKind: 'slide' }, fonts: [] },
})

const unit = (index: number, produced: number, body?: string) => ({
  type: 'unit' as const,
  index,
  unit: body === undefined ? { index, slide: { nodes: [] } } : { index, body },
  unitsProduced: produced,
})

const frame = (overrides: Record<string, string> = {}): Record<string, string> => ({
  format: 'pptx',
  document: canonicalJson(document().document),
  unitCount: '3',
  unitsProduced: '1',
  count: '1',
  'unit:0': canonicalJson(unit(0, 1).unit),
  updatedAt: '1700000000000',
  ...overrides,
})

function makeCache(options: Partial<HotCacheOptions> = {}): HotCache {
  const hot = createHotCache({
    mode: 'redis',
    store: new FakeStore(),
    keyPrefix: PREFIX,
    previewMaxUnits: 8,
    previewTtlMs: 60_000,
    progressTtlMs: 300_000,
    progressThrottleMs: 200,
    maxFieldBytes: CACHE_DEFAULTS.maxFieldBytes,
    ...options,
  })
  openCaches.push(hot)
  return hot
}

function makeMemory(options: Partial<HotCacheOptions> = {}): HotCache {
  const hot = createHotCache({ mode: 'memory', previewMaxUnits: 8, ...options })
  openCaches.push(hot)
  return hot
}

describe('memory mode', () => {
  it('delegates to the shared registry, counts reads and never touches the store', async () => {
    const store = new FakeStore()
    const registry = new PreviewRegistry({ now: () => 1000 })
    const hot = makeMemory({ store, previewRegistry: registry, now: () => 1000 })
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    expect(registry.peek(ARTIFACT_KEY)).toMatchObject({ unitsProduced: 1, cachedUntil: 1 })
    const snapshot = await hot.lookup(ARTIFACT_KEY)
    expect(snapshot).toMatchObject({
      key: ARTIFACT_KEY,
      format: 'pptx',
      unitCount: 3,
      unitsProduced: 1,
      cachedUntil: 1,
      complete: false,
      previewable: true,
      updatedAt: 1000,
    })
    expect(snapshot?.units).toEqual([{ index: 0, slide: { nodes: [] } }])
    expect(hot.stats()).toMatchObject({
      mode: 'memory',
      enabled: false,
      hits: 1,
      misses: 0,
      commands: 0,
      breaker: 'closed',
    })
    await hot.lookup('missing')
    expect(hot.stats().misses).toBe(1)
    hot.reportProgress(JOB_ID, 1, 3)
    expect(await hot.readProgress(JOB_ID)).toBeUndefined()
    await settle()
    expect(store.journal).toHaveLength(0)
    expect(store.stats.commands).toBe(0)
    expect(store.closed).toBe(false)
  })

  it('clears the shared registry on close', async () => {
    const registry = new PreviewRegistry()
    const hot = makeMemory({ previewRegistry: registry })
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    expect(registry.peek(ARTIFACT_KEY)).toBeDefined()
    await hot.close()
    expect(registry.peek(ARTIFACT_KEY)).toBeUndefined()
  })

  it('returns exactly the PreviewRegistry snapshot shape', async () => {
    const registry = new PreviewRegistry({ maxUnits: 8, now: () => 500 })
    const reference = new PreviewRegistry({ maxUnits: 8, now: () => 500 })
    const hot = makeMemory({ previewRegistry: registry, now: () => 500 })
    const events: BuildPreviewEvent[] = [document(), unit(0, 1), unit(1, 2)]
    for (const event of events) {
      hot.report(JOB_ID, ARTIFACT_KEY, event)
      reference.report(ARTIFACT_KEY, event)
    }
    expect(await hot.lookup(ARTIFACT_KEY)).toEqual(reference.get(ARTIFACT_KEY))
  })
})

describe('redis preview mirror', () => {
  it('mirrors a canonical document frame with TTL and initial counters', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store, now: () => 1234 })
    hot.report(JOB_ID, ARTIFACT_KEY, { ...document(), styles: { default: { size: 12 } } })
    await settle()
    const [entry] = store.hsetEntries(pvKey())
    expect(entry?.ttlSeconds).toBe(60)
    expect(entry?.values).toEqual({
      format: 'pptx',
      document: canonicalJson(document().document),
      styles: canonicalJson({ default: { size: 12 } }),
      unitCount: '3',
      unitsProduced: '0',
      count: '0',
      updatedAt: '1234',
    })
    expect(store.hashes.get(pvKey())).toEqual(entry?.values)
    expect(store.ttls.get(pvKey())).toBe(60)
  })

  it('abandons the cross-node preview when the canonical document is too large', async () => {
    const store = new FakeStore()
    makeCache({ store, maxFieldBytes: 10_000 }).report(JOB_ID, ARTIFACT_KEY, document())
    await settle()
    expect(store.hashes.get(pvKey())).toBeDefined()
    const narrow = makeCache({ store, maxFieldBytes: 16 })
    narrow.report(JOB_ID, ARTIFACT_KEY, document())
    await settle()
    expect(store.hashes.has(pvKey())).toBe(false)
    expect(store.journal.some(
      (entry) => entry.command === 'del' && (entry.keys ?? []).includes(pvKey()),
    )).toBe(true)
    // A later unit must not recreate a frame that no reader can render.
    narrow.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    await settle()
    expect(store.hashes.has(pvKey())).toBe(false)
    expect(store.hsetEntries(pvKey())).toHaveLength(1)
  })

  it('mirrors only locally retained consecutive frames and stops at the window edge', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store, previewMaxUnits: 2 })
    hot.report(JOB_ID, ARTIFACT_KEY, document(4))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(1, 2))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(2, 3))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(3, 4))
    await settle()
    const hash = store.hashes.get(pvKey())
    expect(hash).toMatchObject({
      'unit:0': canonicalJson(unit(0, 1).unit),
      'unit:1': canonicalJson(unit(1, 2).unit),
      unitsProduced: '2',
      count: '2',
    })
    expect(hash?.['unit:2']).toBeUndefined()
    expect(store.hsetEntries(pvKey())).toHaveLength(3)
  })

  it('stops mirroring after a unit field exceeds maxFieldBytes (boundary included)', async () => {
    const store = new FakeStore()
    const body = 'x'.repeat(100)
    const limit = Buffer.byteLength(canonicalJson(unit(0, 1, body).unit))
    expect(Buffer.byteLength(canonicalJson(document().document))).toBeLessThan(limit)
    const hot = makeCache({ store, previewMaxUnits: 4, maxFieldBytes: limit })
    hot.report(JOB_ID, ARTIFACT_KEY, document(3))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1, body))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(1, 2, 'z'.repeat(400)))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(2, 3))
    await settle()
    const hash = store.hashes.get(pvKey())
    expect(hash?.['unit:0']).toBe(canonicalJson(unit(0, 1, body).unit))
    expect(hash?.['unit:1']).toBeUndefined()
    expect(hash?.count).toBe('1')
    expect(store.hsetEntries(pvKey())).toHaveLength(2)
  })

  it('deletes the preview frame and progress projection on failure', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store, progressThrottleMs: 20 })
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    hot.reportProgress(JOB_ID, 1, 3)
    await settle()
    expect(store.hashes.get(pvKey())).toBeDefined()
    hot.report(JOB_ID, ARTIFACT_KEY, { type: 'failed' })
    await settle()
    expect(store.hashes.has(pvKey())).toBe(false)
    expect(store.hashes.has(jobKey())).toBe(false)
    const deletion = store.journal.filter((entry) => entry.command === 'del').at(-1)
    expect(deletion?.keys).toEqual([pvKey(), jobKey()])
    expect(await hot.lookup(ARTIFACT_KEY)).toBeUndefined()
    // The pending thottled write must not resurrect the deleted projection.
    await sleep(40)
    expect(store.hashes.has(jobKey())).toBe(false)
    expect(store.hsetEntries(jobKey())).toHaveLength(0)
  })

  it('forces a final progress write on done and keeps the frame to its TTL', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store, progressThrottleMs: 5000 })
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    hot.report(JOB_ID, ARTIFACT_KEY, unit(1, 2))
    hot.reportProgress(JOB_ID, 2, 3)
    expect(store.hsetEntries(jobKey())).toHaveLength(0)
    hot.report(JOB_ID, ARTIFACT_KEY, { type: 'done' })
    await settle()
    const [progress] = store.hsetEntries(jobKey())
    expect(progress?.ttlSeconds).toBe(300)
    expect(progress?.values).toMatchObject({ unitsProduced: '2', unitCount: '3' })
    expect(store.hashes.get(pvKey())).toBeDefined()
    expect((await hot.lookup(ARTIFACT_KEY))?.complete).toBe(true)
    // A reader on another instance still never sees complete from the cache.
    const reader = makeCache({ store })
    expect(await reader.lookup(ARTIFACT_KEY, JOB_ID)).toMatchObject({
      complete: false,
      previewable: true,
      unitsProduced: 2,
      cachedUntil: 2,
    })
  })
})

describe('progress projection', () => {
  it('throttles globally, keeps the latest value and flushes on force', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store, progressThrottleMs: 30 })
    hot.reportProgress(JOB_ID, 1, 3)
    hot.reportProgress(JOB_ID, 2, 3)
    hot.reportProgress(OTHER_JOB_ID, 1, 2)
    expect(store.hsetEntries(jobKey())).toHaveLength(0)
    expect(store.hsetEntries(jobKey(OTHER_JOB_ID))).toHaveLength(0)
    await sleep(60)
    expect(store.hsetEntries(jobKey())).toHaveLength(1)
    expect(store.hsetEntries(jobKey())[0]?.values).toMatchObject({ unitsProduced: '2', unitCount: '3' })
    expect(store.hsetEntries(jobKey(OTHER_JOB_ID))).toHaveLength(1)
    hot.reportProgress(JOB_ID, 3, 3, true)
    await settle()
    expect(store.hsetEntries(jobKey())).toHaveLength(2)
    expect(store.hsetEntries(jobKey())[1]?.values).toMatchObject({ unitsProduced: '3' })
  })

  it('validates progress reads strictly and degrades on failures', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store })
    expect(await hot.readProgress(JOB_ID)).toBeUndefined()
    store.hashes.set(jobKey(), { unitsProduced: '2', unitCount: '3' })
    expect(await hot.readProgress(JOB_ID)).toEqual({ unitsProduced: 2, unitCount: 3 })
    const invalid: Record<string, string>[] = [
      { unitsProduced: '01', unitCount: '3' },
      { unitsProduced: '2', unitCount: '3.0' },
      { unitsProduced: '4', unitCount: '3' },
      { unitsProduced: '-1', unitCount: '3' },
      {},
    ]
    for (const hash of invalid) {
      store.hashes.set(jobKey(), hash)
      expect(await hot.readProgress(JOB_ID)).toBeUndefined()
    }
    store.failHgetall = new Error('down')
    expect(await hot.readProgress(JOB_ID)).toBeUndefined()
    expect(hot.stats().errors).toBe(1)
  })
})

describe('shared frame reads', () => {
  it('reads a mirrored frame from another instance and never reports complete', async () => {
    const store = new FakeStore()
    store.hashes.set(pvKey(), frame({
      unitsProduced: '2',
      count: '2',
      'unit:1': canonicalJson(unit(1, 2).unit),
    }))
    const hot = makeCache({ store })
    const snapshot = await hot.lookup(ARTIFACT_KEY, JOB_ID)
    expect(snapshot).toMatchObject({
      key: ARTIFACT_KEY,
      format: 'pptx',
      unitCount: 3,
      unitsProduced: 2,
      cachedUntil: 2,
      complete: false,
      previewable: true,
    })
    expect(snapshot?.document).toEqual(document().document)
    expect(snapshot?.units).toEqual([unit(0, 1).unit, unit(1, 2).unit])
    expect(hot.stats()).toMatchObject({ hits: 1, misses: 0 })
    // A local hit is served without another command and still counts as a hit.
    store.hashes.set(pvKey(), frame())
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    const commands = store.stats.commands
    expect(await hot.lookup(ARTIFACT_KEY)).toBeDefined()
    expect(store.stats.commands).toBe(commands)
    expect(hot.stats().hits).toBe(2)
  })

  it('never scans or guesses without a jobId', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store })
    const commands = store.stats.commands
    expect(await hot.lookup(ARTIFACT_KEY)).toBeUndefined()
    expect(await hot.lookup(ARTIFACT_KEY, 'bad job')).toBeUndefined()
    expect(await hot.lookup('not-an-artifact-key', JOB_ID)).toBeUndefined()
    expect(store.stats.commands).toBe(commands)
    expect(hot.stats()).toMatchObject({ hits: 0, misses: 3 })
  })

  it('treats malformed or failing remote frames as misses', async () => {
    const store = new FakeStore()
    const hot = makeCache({ store })
    const variants = [
      frame({ document: '{bad' }),
      frame({ format: 'pdf' }),
      frame({ unitCount: '3.0' }),
      frame({ unitsProduced: '99' }),
      frame({ count: '2' }),
      frame({ 'unit:0': '{bad' }),
      frame({ styles: '{bad' }),
      frame({ document: canonicalJson({ fonts: [] }) }),
    ]
    for (const hash of variants) {
      store.hashes.set(pvKey(), hash)
      expect(await hot.lookup(ARTIFACT_KEY, JOB_ID)).toBeUndefined()
    }
    expect(hot.stats().misses).toBe(variants.length)
    store.failHgetall = new Error('down')
    expect(await hot.lookup(ARTIFACT_KEY, JOB_ID)).toBeUndefined()
    expect(hot.stats().errors).toBe(1)
  })

  it('reports hit rate, latency buckets and client counters', async () => {
    const store = new FakeStore()
    store.stats.timeouts = 2
    store.stats.errors = 5
    store.stats.breakerOpenedAt = 999
    store.stats.lastErrorAt = 777
    const hot = makeCache({ store, now: () => 100 })
    await hot.lookup(ARTIFACT_KEY)
    store.hashes.set(pvKey(), frame())
    await hot.lookup(ARTIFACT_KEY, JOB_ID)
    store.failHgetall = new Error('down')
    await hot.readProgress(JOB_ID)
    const stats = hot.stats()
    expect(stats).toMatchObject({
      mode: 'redis',
      enabled: true,
      hits: 1,
      misses: 1,
      errors: 1,
      timeouts: 2,
      commands: store.stats.commands,
      breaker: 'open',
      lastErrorAt: 777,
    })
    expect(stats.hitRate).toBe(0.5)
    expect(stats.latency.buckets).toHaveLength(CACHE_DEFAULTS.latencyBuckets.length + 1)
    expect(stats.latency.count).toBe(3)
    expect(stats.latency.sum).toBeGreaterThanOrEqual(0)
  })
})

describe('degradation and lifecycle', () => {
  it('never throws into a build when store writes fail', async () => {
    const store = new FakeStore()
    store.failHset = new Error('write failed')
    const hot = makeCache({ store })
    expect(() => hot.report(JOB_ID, ARTIFACT_KEY, document())).not.toThrow()
    expect(() => hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))).not.toThrow()
    expect(() => hot.reportProgress(JOB_ID, 1, 2, true)).not.toThrow()
    // Local preview state is unaffected by mirrored-write failures.
    expect(await hot.lookup(ARTIFACT_KEY)).toMatchObject({ unitsProduced: 1 })
    expect(() => hot.report(JOB_ID, ARTIFACT_KEY, { type: 'failed' })).not.toThrow()
    hot.reportProgress(JOB_ID, 1, 2)
    await sleep(20)
    expect(hot.stats().errors).toBeGreaterThanOrEqual(2)
    expect(store.closed).toBe(false)
  })

  it('clears the throttle timer, drains in-flight writes and closes the store once', async () => {
    const store = new FakeStore()
    store.delayMs = 5
    const hot = makeCache({ store, progressThrottleMs: 60 })
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.reportProgress(JOB_ID, 1, 3)
    await hot.close()
    expect(store.closed).toBe(true)
    expect(store.hashes.get(pvKey())).toBeDefined()
    expect(store.hsetEntries(jobKey())).toHaveLength(0)
    await sleep(80)
    expect(store.hsetEntries(jobKey())).toHaveLength(0)
    await hot.close()
    expect(store.journal.filter((entry) => entry.command === 'close')).toHaveLength(1)
  })

  it('does not leave unhandled rejections when writes fail near shutdown', async () => {
    const store = new FakeStore()
    store.failHset = new Error('boom')
    const hot = makeCache({ store })
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.reportProgress(JOB_ID, 0, 3, true)
    await settle()
    await hot.close()
    expect(hot.stats().errors).toBeGreaterThanOrEqual(2)
    expect(store.closed).toBe(true)
  })

  it('degrades to local-only redis mode when no store is configured', async () => {
    const hot = createHotCache({ mode: 'redis', previewMaxUnits: 8 })
    openCaches.push(hot)
    expect(hot.enabled).toBe(false)
    hot.report(JOB_ID, ARTIFACT_KEY, document())
    hot.report(JOB_ID, ARTIFACT_KEY, unit(0, 1))
    expect(await hot.lookup(ARTIFACT_KEY)).toMatchObject({
      unitsProduced: 1,
      complete: false,
      previewable: true,
    })
    expect(await hot.readProgress(JOB_ID)).toBeUndefined()
    hot.reportProgress(JOB_ID, 1, 3)
    await settle()
    expect(hot.stats()).toMatchObject({
      mode: 'redis',
      enabled: false,
      commands: 0,
      hits: 1,
      hitRate: 1,
    })
  })

  it('rejects invalid options at construction', () => {
    expect(() => createHotCache({ mode: 'memory', previewMaxUnits: 0 }))
      .toThrow(/previewMaxUnits/)
    expect(() => createHotCache({ mode: 'memory', previewMaxUnits: 8, maxFieldBytes: 0 }))
      .toThrow(/maxFieldBytes/)
    expect(() => createHotCache({ mode: 'memory', previewMaxUnits: 8, progressThrottleMs: -1 }))
      .toThrow(/progressThrottleMs/)
    expect(() => createHotCache({ mode: 'bogus' as CacheMode, previewMaxUnits: 8 }))
      .toThrow(/mode/)
  })
})
