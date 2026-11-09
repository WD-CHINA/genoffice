import { expect, it, vi } from 'vitest'
import { ArtifactReadyEviction } from '../src/artifact-ready-eviction'
import {
  artifactGenerationPath,
  type ReadyArtifact,
  type ReadyEvictionCandidate,
} from '../src/artifact-catalog'
import type {
  PressureRound,
  SharedPressureLedger,
  SharedPressureState,
} from '../src/storage-pressure'
import { validateRuntimeOptions } from '../src/runtime-options'
import type { ParseServerOptions } from '../src/server'

const hash = 'a'.repeat(64)
function candidate(index: number, bytes = 100): ReadyEvictionCandidate {
  const key = index.toString(16).padStart(64, '0')
  const artifact: ReadyArtifact = { key, generation: 1,
    storagePath: artifactGenerationPath(key, 1), manifestSha256: hash, bytes, unitCount: 1 }
  return { artifact, fileId: `file-${index}`, lastAccessAt: index * 1000 }
}

/**
 * Two "instances" share one ledger but have independent local state. All ledger
 * operations are serialized through a promise tail so concurrent reserves are
 * genuinely atomic, like the single-row conditional UPDATE in SQL.
 */
class MemoryPressureLedger implements SharedPressureLedger {
  private tail: Promise<void> = Promise.resolve()
  private row?: { round: number; targetBytes: number; reclaimedBytes: number; expiresAt: number }
  readonly registers: number[] = []
  readonly reserves: Array<[number, number]> = []
  readonly refunds: Array<[number, number]> = []
  now = 1_700_000_000_000

  constructor(private readonly roundMs = 300_000, private readonly cooldownMs = 30_000) {}

  private async serial<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail
    let unlock!: () => void
    this.tail = new Promise<void>((resolve) => { unlock = resolve })
    await previous
    try { return await work() } finally { unlock() }
  }

  private view(): SharedPressureState {
    const row = this.row!
    return { round: row.round, targetBytes: row.targetBytes,
      reclaimedBytes: row.reclaimedBytes,
      remainingBytes: Math.max(0, row.targetBytes - row.reclaimedBytes) }
  }

  private freshRow(now: number) {
    if (!this.row || this.row.expiresAt <= now)
      this.row = { round: (this.row?.round ?? 0) + 1, targetBytes: 0,
        reclaimedBytes: 0, expiresAt: now + this.roundMs }
    return this.row
  }

  async register(bytes: number): Promise<SharedPressureState> {
    return this.serial(() => {
      this.registers.push(bytes)
      const row = this.freshRow(this.now)
      row.targetBytes = Math.max(row.targetBytes, bytes)
      if (row.reclaimedBytes < row.targetBytes)
        row.expiresAt = Math.max(row.expiresAt, this.now + this.roundMs)
      return this.view()
    })
  }

  async reserve(round: number, bytes: number): Promise<boolean> {
    return this.serial(() => {
      this.reserves.push([round, bytes])
      // An expired row is never silently rolled over by a charge (SQL uses
      // WHERE expires_at_ms > now); only register() starts a new round.
      if (!this.row || this.row.expiresAt <= this.now || this.row.round !== round) return false
      const row = this.row
      if (row.reclaimedBytes + bytes > row.targetBytes) return false
      row.reclaimedBytes += bytes
      if (row.reclaimedBytes >= row.targetBytes)
        row.expiresAt = Math.min(row.expiresAt, this.now + this.cooldownMs)
      return true
    })
  }

  async refund(round: number, bytes: number): Promise<void> {
    await this.serial(() => {
      this.refunds.push([round, bytes])
      if (!this.row || this.row.round !== round || this.row.reclaimedBytes < bytes) return
      this.row.reclaimedBytes -= bytes
    })
  }

  async state(): Promise<PressureRound | null> {
    return this.serial(() => {
      if (!this.row) return null
      return { ...this.view(), expiresAt: this.row.expiresAt,
        expired: this.row.expiresAt <= this.now }
    })
  }

  advance(ms: number): void { this.now += ms }
}

/** Shared SQL rows: whichever instance wins compare-and-clear reclaims the row. */
function fleet(options: {
  count?: number
  bytes?: number
  sourceExists?: (fileId: string) => boolean
  collect?: boolean
  ledger?: MemoryPressureLedger
} = {}) {
  const candidates = Array.from({ length: options.count ?? 3 },
    (_, index) => candidate(index + 1, options.bytes ?? 100))
  const withdrawn = new Set<string>()
  const ledger = options.ledger ?? new MemoryPressureLedger()
  const instances = Array.from({ length: 2 }, () => {
    const catalog = {
      listReadyEvictionCandidates: vi.fn(async () => candidates),
      withdrawReady: vi.fn(async (artifact: ReadyArtifact) => {
        if (withdrawn.has(artifact.key)) return false
        withdrawn.add(artifact.key)
        return true
      }),
      retireGeneration: vi.fn(async () => true),
    }
    const disk = { collect: vi.fn(async () => options.collect ?? true) }
    const eviction = new ArtifactReadyEviction(catalog, disk, {
      idleMs: 0,
      sourceExists: async (fileId) => options.sourceExists?.(fileId) ?? true,
      ledger,
    })
    return { eviction, catalog, disk }
  })
  return { instances, candidates, ledger, withdrawn }
}

it('merges concurrent pressure signals with MAX, never SUM', async () => {
  const ledger = new MemoryPressureLedger()
  expect(await ledger.state()).toBeNull()
  const first = await ledger.register(100)
  const second = await ledger.register(200)
  const third = await ledger.register(150)
  expect(first).toMatchObject({ round: 1, targetBytes: 100, remainingBytes: 100 })
  expect(second).toMatchObject({ round: 1, targetBytes: 200, remainingBytes: 200 })
  expect(third).toMatchObject({ round: 1, targetBytes: 200, remainingBytes: 200 })
  expect(ledger.registers).toEqual([100, 200, 150])
})

it('atomically bounds concurrent reserves to one shared target', async () => {
  const ledger = new MemoryPressureLedger()
  const round = (await ledger.register(100)).round
  const results = await Promise.all([ledger.reserve(round, 80), ledger.reserve(round, 80)])
  expect(results.filter(Boolean)).toHaveLength(1)
  const state = await ledger.state()
  expect(state).toMatchObject({ round: 1, targetBytes: 100, reclaimedBytes: 80,
    remainingBytes: 20 })
  expect(await ledger.reserve(round, 20)).toBe(true)
  expect((await ledger.state())!.remainingBytes).toBe(0)
  expect(await ledger.reserve(round, 1)).toBe(false)
})

it('refunds a charge and refuses stale or expired rounds', async () => {
  const ledger = new MemoryPressureLedger(10_000, 1000)
  const round = (await ledger.register(100)).round
  expect(await ledger.reserve(round, 60)).toBe(true)
  await ledger.refund(round, 60)
  expect((await ledger.state())!.reclaimedBytes).toBe(0)
  expect(await ledger.reserve(round + 1, 10)).toBe(false)
  ledger.advance(10_001)
  expect(await ledger.reserve(round, 10)).toBe(false)
  const next = await ledger.register(50)
  expect(next).toMatchObject({ round: round + 1, targetBytes: 50, remainingBytes: 50 })
  expect(await ledger.reserve(round, 10)).toBe(false)
  expect(await ledger.reserve(next.round, 10)).toBe(true)
})

it('a satisfied round expires after the short cooldown, not the full TTL', async () => {
  const ledger = new MemoryPressureLedger(300_000, 30_000)
  const round = (await ledger.register(100)).round
  expect(await ledger.reserve(round, 100)).toBe(true)
  const state = (await ledger.state())!
  expect(state.expired).toBe(false)
  expect(state.expiresAt).toBeLessThanOrEqual(ledger.now + 30_000)
  ledger.advance(30_001)
  expect((await ledger.state())!.expired).toBe(true)
  expect(await ledger.reserve(round, 1)).toBe(false)
  expect(await ledger.register(100)).toMatchObject({ round: round + 1,
    remainingBytes: 100 })
})

it('request never touches the shared ledger; only a background pass does', () => {
  const { instances, ledger } = fleet()
  const [a, b] = instances
  a.eviction.request(500)
  b.eviction.request(500)
  expect(ledger.registers).toEqual([])
  expect(ledger.reserves).toEqual([])
  expect(a.catalog.listReadyEvictionCandidates).not.toHaveBeenCalled()
})

it('two instances racing on the same ready rows reclaim only the shared target', async () => {
  const { instances, ledger, withdrawn } = fleet()
  const [a, b] = instances
  a.eviction.request(100)
  b.eviction.request(100)
  const [first, second] = await Promise.all([a.eviction.run(), b.eviction.run()])
  expect(first.withdrawn + second.withdrawn).toBe(1)
  expect(first.collected + second.collected).toBe(1)
  expect(first.bytesFreed + second.bytesFreed).toBe(100)
  expect(withdrawn.size).toBe(1)
  expect(first.shared?.targetBytes ?? second.shared?.targetBytes).toBe(100)
  expect((await ledger.state())!.reclaimedBytes).toBe(100)
  expect((await ledger.state())!.targetBytes).toBe(100)
  // The loser either sees an already satisfied round or loses the atomic charge.
  const loser = first.withdrawn === 1 ? second : first
  expect(loser.withdrawn).toBe(0)
  expect(loser.sharedExhausted || loser.examined === 0).toBe(true)
})

it('a larger shared target lets the fleet split work without exceeding it', async () => {
  const { instances, ledger } = fleet({ count: 5 })
  const [a, b] = instances
  a.eviction.request(300)
  b.eviction.request(300)
  const [first, second] = await Promise.all([a.eviction.run(), b.eviction.run()])
  const total = first.withdrawn + second.withdrawn
  expect(total).toBeGreaterThan(0)
  expect(total).toBeLessThanOrEqual(3)
  const bytes = first.bytesFreed + second.bytesFreed
  expect(bytes).toBe(total * 100)
  expect(bytes).toBeLessThanOrEqual(300)
  const state = (await ledger.state())!
  expect(state.targetBytes).toBe(300)
  expect(state.reclaimedBytes).toBe(bytes)
  expect(state.reclaimedBytes).toBeLessThanOrEqual(state.targetBytes)
})

it('refuses to fall back to unbounded local reclamation when the ledger fails', async () => {
  const ledger = new MemoryPressureLedger()
  const broken: SharedPressureLedger = {
    register: async () => { throw Object.assign(new Error('SQL down'), { code: 'ECONNRESET' }) },
    reserve: ledger.reserve.bind(ledger),
    refund: ledger.refund.bind(ledger),
    state: ledger.state.bind(ledger),
  }
  const { instances } = fleet({ ledger: undefined })
  const catalog = instances[0].catalog
  const disk = instances[0].disk
  const eviction = new ArtifactReadyEviction(catalog, disk, {
    sourceExists: async () => true, ledger: broken,
  })
  eviction.request(500)
  const result = await eviction.run()
  expect(result).toMatchObject({ withdrawn: 0, bytesFreed: 0, failed: 1,
    pendingBytes: 500 })
  expect(result.errors).toEqual(['ECONNRESET'])
  expect(catalog.listReadyEvictionCandidates).not.toHaveBeenCalled()
  expect(catalog.withdrawReady).not.toHaveBeenCalled()
})

it('refunds every charge that freed no bytes', async () => {
  const { instances, ledger } = fleet({ sourceExists: () => false })
  const [a] = instances
  a.eviction.request(300)
  const result = await a.eviction.run()
  expect(result).toMatchObject({ examined: 3, withdrawn: 0, collected: 0,
    protected: 3, bytesFreed: 0 })
  expect(ledger.refunds).toHaveLength(3)
  expect((await ledger.state())!.reclaimedBytes).toBe(0)
  expect((await ledger.state())!.remainingBytes).toBe(300)
})

it('a satisfied shared round clears the local hint and stops further scans', async () => {
  const { instances, ledger } = fleet()
  const [a, b] = instances
  a.eviction.request(100)
  const first = await a.eviction.run()
  expect(first).toMatchObject({ withdrawn: 1, collected: 1 })
  b.eviction.request(100)
  const second = await b.eviction.run()
  expect(second).toMatchObject({ examined: 0, withdrawn: 0, pendingBytes: 0,
    hasMore: false })
  expect(ledger.reserves).toHaveLength(1)
})

it('keeps instance-local accounting when no shared ledger is configured', async () => {
  const catalog = {
    listReadyEvictionCandidates: vi.fn(async () => [candidate(1)]),
    withdrawReady: vi.fn(async () => true),
    retireGeneration: vi.fn(async () => true),
  }
  const disk = { collect: vi.fn(async () => true) }
  const eviction = new ArtifactReadyEviction(catalog, disk, {
    sourceExists: async () => true,
  })
  eviction.request(100)
  const result = await eviction.run()
  expect(result).toMatchObject({ withdrawn: 1, collected: 1, bytesFreed: 100 })
  expect(result.shared).toBeUndefined()
})

it('validates shared pressure durations at startup', () => {
  const base: ParseServerOptions = { dataDir: '/tmp/genoffice-pressure-options' }
  expect(() => validateRuntimeOptions({ ...base, pressureRoundMs: 10_000,
    pressureCooldownMs: 60_000 })).toThrow(/cooldown/)
  expect(() => validateRuntimeOptions({ ...base, pressureRoundMs: 0 })).toThrow(/pressureRoundMs/)
  expect(() => validateRuntimeOptions({ ...base, pressureRoundMs: 10_000,
    pressureCooldownMs: 1000 })).not.toThrow()
})
