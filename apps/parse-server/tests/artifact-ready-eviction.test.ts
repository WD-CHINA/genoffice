import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ArtifactReadyEviction,
  type ReadyEvictionOptions,
  type ReadyEvictionResult,
} from '../src/artifact-ready-eviction'
import {
  artifactGenerationPath,
  type ReadyArtifact,
  type ReadyEvictionCandidate,
} from '../src/artifact-catalog'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactGenerationSweeper } from '../src/artifact-generation-sweeper'

const hash = 'a'.repeat(64)
function ready(index: number, bytes = 100): ReadyArtifact {
  const key = index.toString(16).padStart(64, '0')
  return { key, generation: 1, storagePath: artifactGenerationPath(key, 1),
    manifestSha256: hash, bytes, unitCount: 1 }
}
function candidate(index: number, bytes = 100): ReadyEvictionCandidate {
  return { artifact: ready(index, bytes), fileId: `file-${index}`, lastAccessAt: index * 1000 }
}

const directories: string[] = []
afterEach(async () => {
  while (directories.length) await rm(directories.pop()!, { recursive: true, force: true })
})

function harness(config: {
  candidates?: ReadyEvictionCandidate[]
  sourceExists?: (fileId: string) => Promise<boolean>
  withdraw?: (artifact: ReadyArtifact) => Promise<boolean>
  collect?: () => Promise<boolean>
  listError?: Error
  options?: Partial<ReadyEvictionOptions>
  onReclaimed?: (result: ReadyEvictionResult) => void
} = {}) {
  const candidates = config.candidates ?? [candidate(1), candidate(2), candidate(3)]
  const catalog = {
    listReadyEvictionCandidates: vi.fn(async (_limit: number, _idleMs: number) => {
      if (config.listError) throw config.listError
      return candidates
    }),
    withdrawReady: vi.fn(async (_artifact: ReadyArtifact) =>
      config.withdraw ? config.withdraw(_artifact) : true),
    retireGeneration: vi.fn(async () => true),
  }
  const disk = { collect: vi.fn(async () => config.collect ? config.collect() : true) }
  const eviction = new ArtifactReadyEviction(catalog, disk, {
    sourceExists: config.sourceExists ?? (async () => true),
    ...config.options,
    ...(config.onReclaimed ? { onReclaimed: config.onReclaimed } : {}),
  })
  return { eviction, catalog, disk, candidates }
}

it('request only records an in-memory pressure target and never touches SQL', () => {
  const { eviction, catalog, disk } = harness()
  eviction.request(500)
  expect(eviction.snapshot).toMatchObject({ pendingBytes: 500, rounds: 1, totalWithdrawn: 0 })
  eviction.request(200) // coalesce, do not accumulate concurrent pressure signals
  expect(eviction.snapshot.pendingBytes).toBe(500)
  eviction.request(900)
  eviction.request(0)
  eviction.request(Number.NaN)
  expect(eviction.snapshot).toMatchObject({ pendingBytes: 900, rounds: 3 })
  expect(catalog.listReadyEvictionCandidates).not.toHaveBeenCalled()
  expect(catalog.withdrawReady).not.toHaveBeenCalled()
  expect(catalog.retireGeneration).not.toHaveBeenCalled()
  expect(disk.collect).not.toHaveBeenCalled()
})

it('does nothing without a pressure request', async () => {
  const { eviction, catalog } = harness()
  expect(await eviction.run()).toMatchObject({ examined: 0, withdrawn: 0, bytesFreed: 0 })
  expect(catalog.listReadyEvictionCandidates).not.toHaveBeenCalled()
})

it('withdraws the oldest rebuildable generations until the target is met', async () => {
  const { eviction, catalog, disk } = harness()
  eviction.request(250)
  const result = await eviction.run()
  expect(result).toMatchObject({ requestedBytes: 250, examined: 3, withdrawn: 3,
    collected: 3, bytesFreed: 300, pendingBytes: 0, protected: 0, failed: 0,
    hasMore: false })
  expect(catalog.listReadyEvictionCandidates).toHaveBeenCalledWith(16, 60_000)
  expect(catalog.withdrawReady).toHaveBeenCalledTimes(3)
  expect(catalog.withdrawReady.mock.calls[0][0]).toEqual(candidate(1).artifact)
  expect(disk.collect).toHaveBeenCalledTimes(3)
  expect(eviction.snapshot).toMatchObject({ totalWithdrawn: 3, totalCollected: 3,
    totalBytes: 300, pendingBytes: 0 })
})

it('stops examining candidates as soon as the requested bytes are freed', async () => {
  const { eviction, catalog, disk } = harness({ options: { batchSize: 2, idleMs: 0 } })
  eviction.request(100)
  const result = await eviction.run()
  expect(result).toMatchObject({ examined: 1, withdrawn: 1, collected: 1, bytesFreed: 100 })
  expect(catalog.listReadyEvictionCandidates).toHaveBeenCalledWith(2, 0)
  expect(disk.collect).toHaveBeenCalledTimes(1)
})

it('never withdraws a cache whose source bytes are gone', async () => {
  const { eviction, catalog, disk } = harness({ sourceExists: async (id) => id !== 'file-2' })
  eviction.request(1000)
  const result = await eviction.run()
  expect(result).toMatchObject({ examined: 3, withdrawn: 2, collected: 2,
    bytesFreed: 200, protected: 1, pendingBytes: 800 })
  expect(catalog.withdrawReady).toHaveBeenCalledTimes(2)
  expect(disk.collect).toHaveBeenCalledTimes(2)
})

it('treats a lost compare-and-clear race as protected, not reclaimed', async () => {
  const { eviction, catalog, disk } = harness({
    withdraw: async (artifact) => artifact.key !== candidate(1).artifact.key,
  })
  eviction.request(1000)
  const result = await eviction.run()
  expect(result).toMatchObject({ examined: 3, withdrawn: 2, collected: 2,
    bytesFreed: 200, protected: 1 })
  expect(disk.collect).toHaveBeenCalledTimes(2)
  expect(catalog.retireGeneration).not.toHaveBeenCalled()
})

it('keeps the pressure debt when retirement/colletion is fenced', async () => {
  const { eviction } = harness({ collect: async () => false })
  eviction.request(1000)
  const result = await eviction.run()
  expect(result).toMatchObject({ withdrawn: 3, collected: 0, bytesFreed: 0,
    protected: 3, pendingBytes: 1000, hasMore: false })
})

it('isolates per-candidate failures and records stable error codes', async () => {
  const failing = Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
  const { eviction, disk } = harness({
    collect: vi.fn(async () => {
      throw failing
    }) as unknown as () => Promise<boolean>,
  })
  eviction.request(1000)
  const result = await eviction.run()
  expect(result).toMatchObject({ examined: 3, withdrawn: 3, collected: 0,
    failed: 3, bytesFreed: 0, pendingBytes: 1000 })
  expect(result.errors).toEqual(['ECONNRESET', 'ECONNRESET', 'ECONNRESET'])
  expect(disk.collect).toHaveBeenCalledTimes(3)
})

it('retains the pressure debt when candidate enumeration fails', async () => {
  const failing = Object.assign(new Error('lock timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT' })
  const { eviction } = harness({ listError: failing })
  eviction.request(800)
  const result = await eviction.run()
  expect(result).toMatchObject({ examined: 0, failed: 1, pendingBytes: 800 })
  expect(result.errors).toEqual(['ER_LOCK_WAIT_TIMEOUT'])
  expect(await eviction.run()).toMatchObject({ failed: 1 })
})

it('coalesces concurrent runs into a single pass', async () => {
  const { eviction, catalog } = harness()
  eviction.request(1000)
  const [first, second] = await Promise.all([eviction.run(), eviction.run()])
  expect(first).toBe(second)
  expect(catalog.listReadyEvictionCandidates).toHaveBeenCalledTimes(1)
  expect(first.withdrawn).toBe(3)
})

it('asks for another pass only when a full batch made progress', async () => {
  const full = harness({ candidates: [candidate(1), candidate(2)], options: { batchSize: 2 } })
  full.eviction.request(10_000)
  expect(await full.eviction.run()).toMatchObject({ collected: 2, hasMore: true })
  const partial = harness({ candidates: [candidate(1)], options: { batchSize: 2 } })
  partial.eviction.request(10_000)
  expect(await partial.eviction.run()).toMatchObject({ collected: 1, hasMore: false })
})

it('stops accepting work after close and rejects invalid options', async () => {
  const { eviction, catalog } = harness()
  eviction.close()
  eviction.request(1000)
  expect(eviction.snapshot.pendingBytes).toBe(0)
  const result = await eviction.run()
  expect(result.withdrawn).toBe(0)
  expect(catalog.withdrawReady).not.toHaveBeenCalled()
  expect(() => harness({ options: { batchSize: 0 } })).toThrow('invalid ready eviction options')
  expect(() => harness({ options: { idleMs: -1 } })).toThrow('invalid ready eviction options')
})

it('folds pressure withdrawal into the generation sweep report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-eviction-sweep-'))
  directories.push(root)
  const reclaimed: ReadyEvictionResult = { requestedBytes: 400, pendingBytes: 0,
    examined: 2, withdrawn: 2, collected: 2, bytesFreed: 400,
    protected: 0, failed: 0, hasMore: true, errors: [] }
  const readyEviction = { run: vi.fn(async () => reclaimed) }
  const sweeper = new ArtifactGenerationSweeper(new ArtifactGenerations(root),
    { retireGeneration: async () => true }, undefined, undefined, { readyEviction })
  const result = await sweeper.sweep()
  expect(readyEviction.run).toHaveBeenCalledTimes(1)
  expect(result).toMatchObject({ readyWithdrawn: 2, readyCollected: 2,
    readyBytes: 400, hasMore: true, examined: 0 })
  await sweeper.close()
})

it('reports a failed withdrawal pass without aborting generation collection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-eviction-failed-'))
  directories.push(root)
  const failure = Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
  const sweeper = new ArtifactGenerationSweeper(new ArtifactGenerations(root),
    { retireGeneration: async () => true }, undefined, undefined,
    { readyEviction: { run: async () => { throw failure } } })
  const result = await sweeper.sweep()
  expect(result).toMatchObject({ failed: 1, readyWithdrawn: 0, examined: 0 })
  expect(result.errors).toEqual([{ key: 'ready-eviction', generation: 0,
    code: 'ER_LOCK_DEADLOCK' }])
  await sweeper.close()
})
