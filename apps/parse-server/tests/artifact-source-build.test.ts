import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { ArtifactSession, type ArtifactSessionInput } from '../src/artifact-session'
import { ArtifactStore, artifactKey } from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import { ArtifactReadHandle } from '../src/artifact-read-handle'
import type { ArtifactReadLease, ArtifactClaim } from '../src/artifact-catalog'
import { DEFAULT_LIMITS } from '../src/limits'
import { ParseQueue } from '../src/parse-queue'
import { isolatedMemory } from '../src/isolated-worker'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function setup(format: 'pptx' | 'docx' = 'pptx') {
  const root = await mkdtemp(join(tmpdir(), 'artifact-source-build-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const input: ArtifactSessionInput = {
    id: randomUUID(), fileId: 'a'.repeat(64), path: join(root, `source.${format}`), width: 960,
    parserVersion: 'test', parserFingerprint: 'source-build', baseUrl: 'http://localhost',
    format, chunkRoot: join(root, 'chunks'), limits: DEFAULT_LIMITS,
    parseTimeoutMs: 10_000, unitTimeoutMs: 10_000, workerMemoryMb: 128, workerRssMb: 512,
    processGroup: randomUUID(),
  }
  await writeFile(input.path, format === 'pptx' ? Buffer.from(await createBlankPptx())
    : await readFile(new URL('./fixtures/docx/behavior.docx', import.meta.url)))
  const identity = ArtifactSession.identity(input)
  const catalog = {
    leaseMs: 30_000,
    claim: vi.fn(async (): Promise<ArtifactClaim> => ({ kind: 'acquired', lease: {
      key: artifactKey(identity), owner: 'test', jobId: randomUUID(), generation: 1, leaseUntil: Date.now() + 30_000,
    } })),
    renew: vi.fn(async () => true), complete: vi.fn(async (_lease: unknown, _summary: unknown) => true),
    fail: vi.fn(async () => true), cancel: vi.fn(async () => true),
  }
  const disk = new ArtifactGenerations(root)
  const coordinator = new ArtifactCoordinator(catalog, disk)
  const queue = new ParseQueue(1, 2, 512, 512)
  cleanup.push(() => queue.close())
  cleanup.push(() => coordinator.close())
  const store = new ArtifactStore(root)
  const build = (demand?: AbortSignal) => coordinator.getOrBuild(identity,
    (writer, signal) => ArtifactSession.build(store, input, writer, queue, signal),
    undefined, undefined, demand)
  return { root, input, catalog, coordinator, queue, store, build, disk }
}

it.each(['pptx', 'docx'] as const)('coordinator builds real %s models and exits its worker before readiness', async (format) => {
  const { input, catalog, queue, store, build } = await setup(format)
  const reader = await build()
  expect((await reader.read('document') as { model: { format: string } }).model.format).toBe(format)
  expect(reader.has('unit:0')).toBe(true)
  expect(catalog.complete).toHaveBeenCalledTimes(1)
  expect(store.stats.sourceParsesStarted).toBe(1)
  expect(queue.memorySnapshot.reservedMb).toBe(0)
  expect(isolatedMemory(input.processGroup!).processes).toBe(0)
})

it('closing the coordinator removes a queued source build without starting a worker', async () => {
  const { root, input, catalog, coordinator, queue, store, build } = await setup()
  let release!: () => void
  const blocker = queue.run(() => new Promise<void>((resolve) => { release = resolve }))
  const result = build()
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await expect.poll(() => queue.snapshot.queued).toBe(1)
    await coordinator.close()
    await rejected
    expect(store.stats.sourceParsesStarted).toBe(0)
    expect(catalog.complete).not.toHaveBeenCalled()
    expect(isolatedMemory(input.processGroup!).processes).toBe(0)
    expect(await readdir(join(root, 'staging'))).toEqual([])
  } finally { release(); await blocker }
})

it.each(['pptx', 'docx'] as const)('closing the coordinator during %s opening waits for parser exit', async (format) => {
  const { root, input, catalog, coordinator, queue, build } = await setup(format)
  const result = build()
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await expect.poll(() => isolatedMemory(input.processGroup!).processes, { interval: 1 }).toBe(1)
  await coordinator.close()
  await rejected
  expect(isolatedMemory(input.processGroup!).processes).toBe(0)
  expect(queue.memorySnapshot.reservedMb).toBe(0)
  expect(catalog.complete).not.toHaveBeenCalled()
  expect(catalog.cancel).toHaveBeenCalledWith(expect.anything(), 'build_cancelled')
  expect(catalog.fail).not.toHaveBeenCalled()
  expect(await readdir(join(root, 'staging'))).toEqual([])
})

it('renders persisted generation models in an isolated worker after removing the original source', async () => {
  const { root: _root, input, catalog, build, disk, store, queue } = await setup()
  await build()
  const [lease, summary] = catalog.complete.mock.calls[0] as unknown as [
    { key: string; generation: number }, { bytes: number; unitCount: number; manifestSha256: string }
  ]
  const ready = { ...summary, key: lease.key, generation: lease.generation,
    storagePath: `artifacts/${lease.key.slice(0, 2)}/${lease.key}/g-${lease.generation}` }
  await rm(input.path)
  const reads = {
    leaseMs: 30_000,
    pin: vi.fn(async () => ({ artifact: ready, lease: { key: ready.key, generation: ready.generation,
      id: randomUUID(), owner: 'renderer', leaseUntil: Date.now() + 30_000 } })),
    renewRead: vi.fn(async () => true), releaseRead: vi.fn(async () => true),
  }
  const handle = (await ArtifactReadHandle.open(reads, disk, ready.key, 'renderer'))!
  const session = await ArtifactSession.openPinned(handle, store, input, queue)
  try {
    expect((await session.unit('0') as { slide: unknown }).slide).toBeDefined()
    expect(reads.releaseRead).not.toHaveBeenCalled()
    let release!: () => void
    const blocker = queue.run(() => new Promise<void>((resolve) => { release = resolve }))
    const pending = session.unit('0')
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await expect.poll(() => queue.snapshot.queued).toBe(1)
      await session.dispose()
      await rejected
      expect(queue.snapshot).toEqual({ running: 1, queued: 0 })
      expect(isolatedMemory(input.processGroup!).processes).toBe(0)
      await expect(session.layoutInfo()).rejects.toThrow('closed')
    } finally { release(); await blocker }
  } finally { await session.dispose() }
  expect(reads.releaseRead).toHaveBeenCalledTimes(1)
  expect(isolatedMemory(input.processGroup!).processes).toBe(0)
})

it('shared offline bundle construction retains its own generation pin after the initiating view closes', async () => {
  const { root: _root, input, catalog, build, disk, store, queue } = await setup()
  await build()
  const [lease, summary] = catalog.complete.mock.calls[0] as unknown as [
    { key: string; generation: number }, { bytes: number; unitCount: number; manifestSha256: string }
  ]
  const ready = { ...summary, key: lease.key, generation: lease.generation,
    storagePath: `artifacts/${lease.key.slice(0, 2)}/${lease.key}/g-${lease.generation}` }
  const reads = {
    leaseMs: 30_000,
    pin: vi.fn(async () => ({ artifact: ready, lease: { key: ready.key, generation: ready.generation,
      id: randomUUID(), owner: 'renderer', leaseUntil: Date.now() + 30_000 } })),
    forkRead: vi.fn(async (source: ArtifactReadLease, owner: string) => ({ ...source, id: randomUUID(), owner })),
    renewRead: vi.fn(async () => true), releaseRead: vi.fn(async () => true),
  }
  const handle = (await ArtifactReadHandle.open(reads, disk, ready.key, 'renderer'))!
  const bundleIdentity = { ...ArtifactSession.identity(input), options: { purpose: 'offline-bundle',
    modelArtifactKey: handle.manifest.key, modelContentDigest: handle.contentDigest } }
  const session = await ArtifactSession.openPinned(handle, store, input, queue)
  let release!: () => void
  const blocker = queue.run(() => new Promise<void>((resolve) => { release = resolve }))
  const bundle = session.bundleManifest()
  const rejected = expect(bundle).rejects.toThrow('closed')
  try {
    await expect.poll(() => queue.snapshot.queued).toBe(1)
    await session.dispose()
    expect(reads.forkRead).toHaveBeenCalledTimes(1)
    expect(reads.releaseRead).toHaveBeenCalledTimes(1)
    release()
    await blocker
    await rejected
    const cached = await store.find(artifactKey(bundleIdentity))
    expect(cached?.has('bundle')).toBe(true)
    expect(reads.releaseRead).toHaveBeenCalledTimes(2)
  } finally { release(); await blocker; await session.dispose() }
})

it('cancels a queued shared build when the last waiter aborts demand', async () => {
  const { input, catalog, queue, store, build } = await setup()
  let release!: () => void
  const blocker = queue.run(() => new Promise<void>((resolve) => { release = resolve }))
  const demand = new AbortController()
  const result = build(demand.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await expect.poll(() => queue.snapshot.queued).toBe(1)
    demand.abort(new DOMException('no waiters', 'AbortError'))
    await rejected
    expect(store.stats.sourceParsesStarted).toBe(0)
    expect(catalog.cancel).toHaveBeenCalledWith(expect.anything(), 'build_cancelled')
    expect(catalog.fail).not.toHaveBeenCalled()
    expect(await readdir(join(input.chunkRoot, input.id)).catch(() => [])).toEqual([])
  } finally { release(); await blocker }
})

it('local store cancels a queued build through the demand signal', async () => {
  const { root, input, queue, store } = await setup()
  let release!: () => void
  const blocker = queue.run(() => new Promise<void>((resolve) => { release = resolve }))
  const demand = new AbortController()
  const result = store.getOrBuild(ArtifactSession.identity(input),
    (writer, signal) => ArtifactSession.build(store, input, writer, queue, signal),
    undefined, undefined, demand.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await expect.poll(() => queue.snapshot.queued).toBe(1)
    demand.abort(new DOMException('no waiters', 'AbortError'))
    await rejected
    expect(store.stats.sourceParsesStarted).toBe(0)
    expect(await readdir(join(root, 'staging')).catch(() => [])).toEqual([])
  } finally { release(); await blocker }
})
