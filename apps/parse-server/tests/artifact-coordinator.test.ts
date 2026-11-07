import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import { ArtifactGenerations } from '../src/artifact-generations'
import type { ArtifactClaim, ArtifactLease, ReadyArtifact } from '../src/artifact-catalog'
import { artifactKey, type ArtifactIdentity } from '../src/artifact-store'

const identity: ArtifactIdentity = { fileId: 'a'.repeat(64), format: 'pptx', parserFingerprint: 'coord-test', schemaVersion: 2, options: {} }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-coordinator-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let claimed = false
  let ready: ReadyArtifact | undefined
  const catalog = {
    leaseMs: 1000,
    claim: vi.fn(async (_identity: ArtifactIdentity, owner: string): Promise<ArtifactClaim> => {
      if (ready) return { kind: 'ready', artifact: ready }
      if (claimed) return { kind: 'busy', leaseUntil: Date.now() + 1000 }
      claimed = true
      return { kind: 'acquired', lease: { key: artifactKey(identity), owner, jobId: 'job', generation: 1, leaseUntil: Date.now() + 1000 } }
    }),
    renew: vi.fn(async () => true),
    complete: vi.fn(async (_lease: ArtifactLease, summary: { bytes: number; unitCount: number; manifestSha256: string }) => {
      ready = { ...summary, key: artifactKey(identity), generation: 1,
        storagePath: `artifacts/${artifactKey(identity).slice(0, 2)}/${artifactKey(identity)}/g-1` }
      return true
    }),
    fail: vi.fn(async () => true),
  }
  const disk = new ArtifactGenerations(root)
  const coordinator = new ArtifactCoordinator(catalog, disk, 5, 1000)
  cleanup.push(() => coordinator.close())
  return { root, disk, catalog, coordinator }
}

it('independent coordinators share a catalog build; a cancelled reader does not cancel it', async () => {
  const { catalog, disk, coordinator } = await setup()
  const other = new ArtifactCoordinator(catalog, disk, 5, 1000)
  cleanup.push(() => other.close())
  let release!: () => void
  let arrived!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { arrived = resolve })
  const reader = new AbortController()
  const first = coordinator.getOrBuild(identity, async (writer, signal) => {
    arrived()
    await gate
    signal.throwIfAborted()
    await writer.append('unit:0', { text: 'shared' })
  }, reader.signal)
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  try {
    await started
    const second = other.getOrBuild(identity, async () => { throw new Error('must not build twice') })
    reader.abort()
    await rejected
    release()
    expect(await (await second).read('unit:0')).toEqual({ text: 'shared' })
    expect(catalog.complete).toHaveBeenCalledTimes(1)
    expect(catalog.fail).not.toHaveBeenCalled()
  } finally { release() }
})

it('lease renewal failure aborts the builder and prevents readiness', async () => {
  const { catalog, coordinator } = await setup()
  catalog.leaseMs = 90
  catalog.renew.mockResolvedValue(false)
  await expect(coordinator.getOrBuild(identity, async (_writer, signal) => {
    await delay(1000, undefined, { signal })
  })).rejects.toMatchObject({ code: 'artifact_lease_lost' })
  expect(catalog.renew).toHaveBeenCalled()
  expect(catalog.complete).not.toHaveBeenCalled()
  expect(catalog.fail).toHaveBeenCalledTimes(1)
})

it('shutdown cancels cooperative work while reader-only cancellation leaves shared work running', async () => {
  const { catalog, coordinator } = await setup()
  let arrived!: () => void
  const started = new Promise<void>((resolve) => { arrived = resolve })
  const work = coordinator.getOrBuild(identity, async (_writer, signal) => {
    arrived()
    await delay(1000, undefined, { signal })
  })
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  await started
  await coordinator.close()
  await rejected
  expect(catalog.complete).not.toHaveBeenCalled()
})

it('busy waits are bounded and never invoke the local builder', async () => {
  const { catalog, disk } = await setup()
  catalog.claim.mockResolvedValue({ kind: 'busy', leaseUntil: Date.now() + 1000 })
  const waiting = new ArtifactCoordinator(catalog, disk, 5, 20)
  cleanup.push(() => waiting.close())
  const build = vi.fn(async () => {})
  await expect(waiting.getOrBuild(identity, build)).rejects.toMatchObject({ code: 'artifact_wait_timeout' })
  expect(build).not.toHaveBeenCalled()
})

it('ambiguous SQL completion leaves the generation available instead of deleting it', async () => {
  const { catalog, disk, coordinator } = await setup()
  const complete = catalog.complete.getMockImplementation()!
  catalog.complete.mockImplementation(async (lease, summary) => {
    await complete(lease, summary)
    throw new Error('lost commit reply')
  })
  await expect(coordinator.getOrBuild(identity, async (writer) => {
    await writer.append('unit:0', { text: 'committed' })
  })).rejects.toThrow('lost commit reply')
  const claim = await catalog.claim(identity, 'reader')
  if (claim.kind !== 'ready') throw new Error('expected ready')
  expect(await (await disk.open(claim.artifact)).read('unit:0')).toEqual({ text: 'committed' })
})

it('a stalled renewal cannot let a builder run beyond its last confirmed local lease window', async () => {
  const { catalog, coordinator } = await setup()
  catalog.leaseMs = 90
  catalog.renew.mockImplementation(() => new Promise<boolean>(() => {}))
  await expect(coordinator.getOrBuild(identity, async (_writer, signal) => {
    await delay(1000, undefined, { signal })
  })).rejects.toMatchObject({ code: 'artifact_lease_lost' })
  expect(catalog.complete).not.toHaveBeenCalled()
  expect(catalog.fail).toHaveBeenCalledTimes(1)
})

it('rebuilds a corrupt ready generation once without deleting its immutable directory', async () => {
  const { root, disk, catalog } = await setup()
  const broken = await disk.publish(identity, 1, async (writer) => { await writer.append('unit:0', { old: true }) })
  await writeFile(join(root, broken.storagePath, 'manifest.json'), '{}')
  const invalidateReady = vi.fn(async () => true)
  catalog.claim.mockResolvedValueOnce({ kind: 'ready', artifact: broken }).mockResolvedValueOnce({ kind: 'acquired',
    lease: { key: broken.key, generation: 2, owner: 'repair', jobId: 'repair-job', leaseUntil: Date.now() + 1000 } })
  const coordinator = new ArtifactCoordinator({ ...catalog, invalidateReady }, disk, 5)
  cleanup.push(() => coordinator.close())
  const reader = await coordinator.getOrBuild(identity, async (writer) => { await writer.append('unit:0', { repaired: true }) })
  expect(await reader.read('unit:0')).toEqual({ repaired: true })
  expect(invalidateReady).toHaveBeenCalledExactlyOnceWith(broken)
  expect(catalog.claim).toHaveBeenCalledTimes(2)
  expect(catalog.complete).toHaveBeenCalledTimes(1)
})

it('does not invalidate a ready generation for an ordinary filesystem permission error', async () => {
  const { disk, catalog } = await setup()
  const ready = await disk.publish(identity, 1, async (writer) => { await writer.append('unit:0', {}) })
  catalog.claim.mockResolvedValue({ kind: 'ready', artifact: ready })
  vi.spyOn(disk, 'open').mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
  const invalidateReady = vi.fn(async () => true)
  const coordinator = new ArtifactCoordinator({ ...catalog, invalidateReady }, disk)
  cleanup.push(() => coordinator.close())
  await expect(coordinator.getOrBuild(identity, async () => { throw new Error('must not build') })).rejects.toMatchObject({ code: 'EACCES' })
  expect(invalidateReady).not.toHaveBeenCalled()
})
