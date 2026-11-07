import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactReadHandle } from '../src/artifact-read-handle'
import { ArtifactCorruptionError, ArtifactReader, artifactKey, type ArtifactIdentity } from '../src/artifact-store'
import type { ArtifactReadLease, ReadyArtifact } from '../src/artifact-catalog'

const identity: ArtifactIdentity = { fileId: 'a'.repeat(64), format: 'pptx', parserFingerprint: 'read-handle', schemaVersion: 2, options: {} }
const key = artifactKey(identity)
const artifact: ReadyArtifact = { key, generation: 1, storagePath: `artifacts/${key.slice(0, 2)}/${key}/g-1`,
  bytes: 100, unitCount: 1, manifestSha256: 'b'.repeat(64) }
const handles: ArtifactReadHandle[] = []
afterEach(async () => { await Promise.allSettled(handles.splice(0).map((handle) => handle.close())) })

function setup() {
  const reader = new ArtifactReader('/test-only', { version: 1, key, identity, createdAt: 0, dataBytes: 1,
    records: [{ id: 'unit:0', encoding: 'json', offset: 0, length: 1, rawLength: 2, sha256: 'c'.repeat(64) }] }, 1024)
  const read = vi.spyOn(reader, 'read').mockResolvedValue({ text: 'data' })
  const catalog = {
    leaseMs: 1000,
    pin: vi.fn(async (_key: string, owner: string, durationMs?: number): Promise<{
      artifact: ReadyArtifact; lease: ArtifactReadLease
    } | null> => ({ artifact, lease: { key, generation: 1, owner, id: randomUUID(), leaseUntil: Date.now() + (durationMs ?? 1000) } })),
    forkRead: vi.fn(async (source: ArtifactReadLease, owner: string) => ({ ...source, id: randomUUID(), owner })),
    renewRead: vi.fn(async () => true),
    releaseRead: vi.fn(async (_lease: ArtifactReadLease) => true),
    invalidateReady: vi.fn(async (_expected: ReadyArtifact) => true),
  }
  const disk = { open: vi.fn(async () => reader) }
  const open = async (durationMs?: number) => {
    const handle = await ArtifactReadHandle.open(catalog, disk, key, 'reader', durationMs)
    if (!handle) throw new Error('missing handle')
    handles.push(handle)
    return handle
  }
  return { reader, read, catalog, disk, open }
}

it('guards reads and metadata after close, and releases the token exactly once', async () => {
  const { catalog, read, open } = setup()
  const handle = await open()
  expect(handle.has('unit:0')).toBe(true)
  expect(handle.describe('unit:0').size).toBe(2)
  expect(handle.manifest.key).toBe(key)
  expect(await handle.read('unit:0')).toEqual({ text: 'data' })
  const closed = handle.close()
  expect(handle.close()).toBe(closed)
  await closed
  await expect(handle.read('unit:0')).rejects.toMatchObject({ name: 'AbortError' })
  expect(() => handle.has('unit:0')).toThrow()
  expect(() => handle.contentDigest).toThrow()
  expect(read).toHaveBeenCalledTimes(1)
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('cancels the waiter immediately but retains its lease until the raw read really settles', async () => {
  const { catalog, read, open } = setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  read.mockImplementation(async () => { await gate; return { text: 'late' } })
  const handle = await open()
  const pending = handle.read('unit:0')
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  const closing = handle.close()
  try {
    await rejected
    expect(catalog.releaseRead).not.toHaveBeenCalled()
  } finally { release(); await closing }
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('lost renewal fences every subsequent operation', async () => {
  const { catalog, open } = setup()
  catalog.renewRead.mockResolvedValue(false)
  const handle = await open(90)
  await expect.poll(() => handle.signal.aborted).toBe(true)
  await expect(handle.read('unit:0')).rejects.toMatchObject({ code: 'artifact_read_lease_lost' })
  await handle.close()
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('a stuck renewal cannot extend the local confirmed lease window', async () => {
  const { catalog, open } = setup()
  catalog.renewRead.mockImplementation(() => new Promise<boolean>(() => {}))
  const handle = await open(90)
  await expect.poll(() => handle.signal.aborted).toBe(true)
  await expect(handle.read('unit:0')).rejects.toMatchObject({ code: 'artifact_read_lease_lost' })
  await handle.close()
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('failed opening releases the pin; absent readiness never opens disk data', async () => {
  const { catalog, disk, open } = setup()
  disk.open.mockRejectedValue(new Error('bad manifest'))
  await expect(open()).rejects.toThrow('bad manifest')
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
  catalog.pin.mockResolvedValue(null)
  expect(await ArtifactReadHandle.open(catalog, disk, key, 'reader')).toBeNull()
  expect(disk.open).toHaveBeenCalledTimes(1)
})

it('an overlong pin round trip is rejected conservatively before opening the generation', async () => {
  const { catalog, disk, open } = setup()
  const original = catalog.pin.getMockImplementation()!
  catalog.pin.mockImplementation(async (...args) => { await delay(80); return original(...args) })
  await expect(open(40)).rejects.toMatchObject({ code: 'artifact_read_lease_lost' })
  expect(disk.open).not.toHaveBeenCalled()
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('retains the pin until an external renderer finishes termination after cancellation', async () => {
  const { catalog, open } = setup()
  const handle = await open()
  let release!: () => void
  const exit = new Promise<void>((resolve) => { release = resolve })
  let ownerSignal: AbortSignal | undefined
  const work = handle.use(async (signal) => { ownerSignal = signal; await exit; return 'late renderer' })
  const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' })
  const closing = handle.close()
  try {
    await rejected
    expect(ownerSignal?.aborted).toBe(true)
    expect(catalog.releaseRead).not.toHaveBeenCalled()
  } finally { release(); await closing }
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
  let invoked = false
  await expect(handle.use(async () => { invoked = true })).rejects.toMatchObject({ name: 'AbortError' })
  expect(invoked).toBe(false)
})

it('reports a damaged frame once per handle against its exact pinned generation', async () => {
  const { catalog, read, open } = setup()
  const damage = new ArtifactCorruptionError('artifact record checksum mismatch')
  read.mockRejectedValue(damage)
  const handle = await open()
  await expect(handle.read('unit:0')).rejects.toBe(damage)
  await expect(handle.read('unit:0')).rejects.toBe(damage)
  expect(catalog.invalidateReady).toHaveBeenCalledTimes(1)
  expect(catalog.invalidateReady).toHaveBeenCalledWith(artifact)
  await handle.close()
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('a forked dependency reports damage against its own independent pin', async () => {
  const { catalog, read, open } = setup()
  const damage = new ArtifactCorruptionError('artifact record compression invalid')
  read.mockRejectedValue(damage)
  const handle = await open()
  const fork = await handle.fork('bundle-worker')
  handles.push(fork)
  await expect(fork.read('unit:0')).rejects.toBe(damage)
  expect(catalog.invalidateReady).toHaveBeenCalledTimes(1)
  expect(catalog.invalidateReady).toHaveBeenCalledWith(artifact)
  await expect(handle.read('unit:0')).rejects.toBe(damage)
  expect(catalog.invalidateReady).toHaveBeenCalledTimes(2)
})

it('closing waits for an in-flight corruption report before releasing the read lease', async () => {
  const { catalog, read, open } = setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  catalog.invalidateReady.mockImplementation(async () => { await gate; return true })
  read.mockRejectedValue(new ArtifactCorruptionError('truncated'))
  const handle = await open()
  const pending = handle.read('unit:0')
  void pending.catch(() => undefined)
  await expect.poll(() => catalog.invalidateReady.mock.calls.length).toBe(1)
  const closing = handle.close()
  expect(catalog.releaseRead).not.toHaveBeenCalled()
  release()
  await closing
  await expect(pending).rejects.toThrow()
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
})

it('forked dependencies survive view closure and own their lease release independently', async () => {
  const { catalog, disk, open } = setup()
  const parent = await open()
  const fork = await parent.fork('bundle-worker')
  handles.push(fork)
  expect(fork.artifact).toEqual(parent.artifact)
  await parent.close()
  expect(await fork.read('unit:0')).toEqual({ text: 'data' })
  expect(fork.signal.aborted).toBe(false)
  expect(disk.open).toHaveBeenCalledTimes(1)
  expect(catalog.releaseRead).toHaveBeenCalledTimes(1)
  await fork.close()
  expect(catalog.releaseRead).toHaveBeenCalledTimes(2)
  const [first, second] = catalog.releaseRead.mock.calls as unknown as [[ArtifactReadLease], [ArtifactReadLease]]
  expect(first[0].id).not.toBe(second[0].id)
})
