import { mkdtemp, mkdir, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as artifactStorage from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactStore, artifactKey, type ArtifactIdentity } from '../src/artifact-store'
import { artifactGenerationPath } from '../src/artifact-catalog'
import { StorageBudget } from '../src/storage-budget'
import { FileLifecycle } from '../src/file-lifecycle'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const identity: ArtifactIdentity = { fileId: 'a'.repeat(64), format: 'pptx', parserFingerprint: 'generation-test', schemaVersion: 2, options: {} }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-generations-'))
  roots.push(root)
  return { root, store: new ArtifactGenerations(root) }
}

it('publishes separate immutable generations and leaves old readers usable', async () => {
  const { root, store } = await setup()
  const first = await store.publish(identity, 1, async (writer) => {
    await writer.append('document', { version: 'one' })
    await writer.append('unit:0', { text: 'old' })
    await writer.append('font:embed:0', new Uint8Array([1, 2, 3]))
  })
  const old = await store.open(first)
  const second = await store.publish(identity, 2, async (writer) => {
    await writer.append('unit:0', { text: 'new' })
  })
  expect(first.storagePath).not.toBe(second.storagePath)
  expect(await old.read('unit:0')).toEqual({ text: 'old' })
  expect(await old.read('font:embed:0')).toEqual(Buffer.from([1, 2, 3]))
  expect(await (await new ArtifactGenerations(root).open(second)).read('unit:0')).toEqual({ text: 'new' })
  expect(first.unitCount).toBe(1)
  expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(await readdir(join(root, 'staging'))).toEqual([])
})

it('only one independent writer can reserve a generation, even before its manifest exists', async () => {
  const { root, store } = await setup()
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observed = new Promise<void>((resolve) => { started = resolve })
  const first = store.publish(identity, 1, async (writer) => {
    started()
    await gate
    await writer.append('unit:0', { text: 'winner' })
  })
  try {
    await observed
    await expect(new ArtifactGenerations(root).publish(identity, 1, async () => {
      throw new Error('duplicate builder must not run')
    })).rejects.toMatchObject({ code: 'EEXIST' })
  } finally { release() }
  expect(await (await store.open(await first)).read('unit:0')).toEqual({ text: 'winner' })
})

it('does not replace an existing empty or complete generation', async () => {
  const { root, store } = await setup()
  const key = artifactKey(identity)
  const path = join(root, artifactGenerationPath(key, 1))
  await mkdir(path, { recursive: true })
  await expect(store.publish(identity, 1, async () => {})).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readdir(path)).toEqual([])
  const ready = await store.publish(identity, 2, async (writer) => { await writer.append('unit:0', { text: 'keep' }) })
  const before = await readFile(join(root, ready.storagePath, 'manifest.json'))
  await expect(store.publish(identity, 2, async () => {})).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(join(root, ready.storagePath, 'manifest.json'))).toEqual(before)
})

it('cleans failed staging without touching older complete generations', async () => {
  const { root, store } = await setup()
  const old = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'keep' }) })
  await expect(store.publish(identity, 2, async (writer) => {
    await writer.append('unit:0', { text: 'partial' })
    throw new Error('injected failure')
  })).rejects.toThrow('injected failure')
  expect(await readdir(join(root, 'staging'))).toEqual([])
  expect(await (await store.open(old)).read('unit:0')).toEqual({ text: 'keep' })
  expect(await readdir(join(root, 'artifacts', old.key.slice(0, 2), old.key))).toEqual(['g-1'])
})

it('checks catalog digest, immutable path and byte/unit summaries when opening', async () => {
  const { root, store } = await setup()
  const ready = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'keep' }) })
  await expect(store.open({ ...ready, storagePath: '../outside' })).rejects.toThrow('invalid generation pointer')
  await expect(store.open({ ...ready, bytes: ready.bytes + 1 })).rejects.toThrow('summary mismatch')
  await expect(store.open({ ...ready, unitCount: 100 })).rejects.toThrow('summary mismatch')
  const manifest = join(root, ready.storagePath, 'manifest.json')
  const bytes = await readFile(manifest, 'utf8')
  await writeFile(manifest, bytes.replace('generation-test', 'generation-fake'))
  await expect(store.open(ready)).rejects.toThrow('checksum mismatch')
})

it('retains an unregistered complete generation when post-rename directory sync fails', async () => {
  const { root, store } = await setup()
  const old = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'old' }) })
  vi.spyOn(artifactStorage, 'syncArtifactDirectory').mockRejectedValueOnce(new Error('injected fsync failure'))
  await expect(store.publish(identity, 2, async (writer) => {
    await writer.append('unit:0', { text: 'unregistered' })
  })).rejects.toThrow('injected fsync failure')
  const path = join(root, artifactGenerationPath(old.key, 2))
  expect(await readdir(path)).toEqual(['manifest.json', 'units.bin'])
  expect(await (await store.open(old)).read('unit:0')).toEqual({ text: 'old' })
})

it('counts all generations and unknown orphan files without trusting manifests or following symlinks', async () => {
  const { root, store } = await setup()
  const first = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'one' }) })
  const second = await store.publish(identity, 2, async (writer) => { await writer.append('unit:0', { text: 'two' }) })
  const legacy = new ArtifactStore(root)
  expect(await legacy.totalBytes()).toBe(first.bytes + second.bytes)
  const manifest = join(root, first.storagePath, 'manifest.json')
  const previousSize = (await readFile(manifest)).length
  await writeFile(manifest, '{bad')
  const orphan = join(root, 'artifacts', first.key.slice(0, 2), first.key, 'g-999', 'scratch')
  await mkdir(orphan, { recursive: true })
  await writeFile(join(orphan, 'partial.bin'), Buffer.alloc(11))
  if (process.platform !== 'win32') {
    await writeFile(join(root, 'outside.bin'), Buffer.alloc(1024 * 1024))
    await symlink(join(root, 'outside.bin'), join(orphan, 'external-link'))
  }
  expect(await legacy.totalBytes()).toBe(first.bytes + second.bytes - previousSize + 4 + 11)
  expect(await legacy.evictionCandidates(identity.parserFingerprint)).toEqual([])
  expect(await legacy.evict(first.key)).toBe(0)
  const build = vi.fn(async () => {})
  await expect(legacy.getOrBuild(identity, build)).rejects.toThrow('requires the catalog backend')
  expect(build).not.toHaveBeenCalled()
  expect(await (await store.open(second)).read('unit:0')).toEqual({ text: 'two' })
})

it('legacy corruption recovery refuses mixed generation directories instead of deleting their data', async () => {
  const { root, store } = await setup()
  const legacy = new ArtifactStore(root)
  const reader = await legacy.getOrBuild(identity, async (writer) => { await writer.append('unit:0', { text: 'legacy' }) })
  const oldBytes = await legacy.totalBytes()
  const generation = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'generation' }) })
  expect(await legacy.totalBytes()).toBe(oldBytes + generation.bytes)
  expect(await legacy.evict(generation.key)).toBe(0)
  await writeFile(join(reader.directory, 'manifest.json'), '{broken')
  await expect(legacy.getOrBuild(identity, async () => {})).rejects.toThrow('requires the catalog backend')
  expect(await (await store.open(generation)).read('unit:0')).toEqual({ text: 'generation' })
})

it('a generation appearing after legacy eviction inspection is preserved and still billed', async () => {
  const { root, store } = await setup()
  const legacy = new ArtifactStore(root)
  const reader = await legacy.getOrBuild(identity, async (writer) => { await writer.append('unit:0', { text: 'legacy' }) })
  const oldBytes = await legacy.totalBytes()
  const find = legacy.find.bind(legacy)
  let generation: Awaited<ReturnType<ArtifactGenerations['publish']>> | undefined
  vi.spyOn(legacy, 'find').mockImplementationOnce(async (key) => {
    const old = await find(key)
    generation = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'new' }) })
    return old
  })
  expect(await legacy.evict(reader.manifest.key)).toBe(oldBytes)
  expect(generation).toBeDefined()
  expect(await legacy.totalBytes()).toBe(generation!.bytes)
  expect(await (await store.open(generation!)).read('unit:0')).toEqual({ text: 'new' })
})

it('generation bytes enforce quota on subsequent writes and failed reservations are released', async () => {
  const { root, store } = await setup()
  const first = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'keep' }) })
  const legacy = new ArtifactStore(root)
  const files = new FileLifecycle()
  const budget = new StorageBudget(first.bytes + 1, () => legacy.totalBytes(),
    (work) => files.withFile('quota', work))
  const limited = new ArtifactGenerations(root, undefined, budget)
  await expect(limited.publish(identity, 2, async (writer) => {
    await writer.append('unit:0', { text: 'over budget' })
  })).rejects.toMatchObject({ code: 'storage_full' })
  expect(budget.reservedBytes).toBe(0)
  expect(await readdir(join(root, 'staging'))).toEqual([])
  expect(await legacy.totalBytes()).toBe(first.bytes)
  expect(await (await store.open(first)).read('unit:0')).toEqual({ text: 'keep' })
})

it('collects only after durable retirement and preserves other generations', async () => {
  const { store } = await setup()
  const first = await store.publish(identity, 1, async (writer) => { await writer.append('unit:0', { text: 'old' }) })
  const next = await store.publish(identity, 2, async (writer) => { await writer.append('unit:0', { text: 'current' }) })
  const retireGeneration = vi.fn(async () => false)
  expect(await store.collect(first.key, 1, { retireGeneration })).toBe(false)
  expect(await (await store.open(first)).read('unit:0')).toEqual({ text: 'old' })
  retireGeneration.mockRejectedValueOnce(new Error('catalog unavailable'))
  await expect(store.collect(first.key, 1, { retireGeneration })).rejects.toThrow('catalog unavailable')
  expect(await (await store.open(first)).read('unit:0')).toEqual({ text: 'old' })
  retireGeneration.mockResolvedValue(true)
  expect(await store.collect(first.key, 1, { retireGeneration })).toBe(true)
  await expect(store.open(first)).rejects.toThrow('generation missing')
  expect(await store.collect(first.key, 1, { retireGeneration })).toBe(true)
  expect(await (await store.open(next)).read('unit:0')).toEqual({ text: 'current' })
})

it('collecting an already missing retired directory is idempotent', async () => {
  const { store } = await setup()
  expect(await store.collect(artifactKey(identity), 1, { retireGeneration: async () => true })).toBe(true)
})

it('legacy age-only staging cleanup cannot remove a generation build', async () => {
  const { root, store } = await setup()
  let release!: () => void
  let arrived!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { arrived = resolve })
  const work = store.publish(identity, 1, async (writer) => {
    await writer.append('unit:0', { text: 'active' })
    arrived()
    await gate
  })
  try {
    await started
    const entries = await readdir(join(root, 'staging'))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatch(/^gen-[a-f0-9]{64}-g-1-/)
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(join(root, 'staging', entries[0]), old, old)
    expect(await new ArtifactStore(root).cleanupStaging(60 * 60_000)).toBe(0)
  } finally { release(); await work.catch(() => undefined) }
  expect(await (await store.open(await work)).read('unit:0')).toEqual({ text: 'active' })
})

it('legacy file-wide cleanup never recursively removes generations', async () => {
  const { root, store } = await setup()
  const legacy = new ArtifactStore(root)
  await legacy.getOrBuild(identity, async (writer) => { await writer.append('unit:0', { text: 'legacy' }) })
  const generation = await store.publish(identity, 1, async (writer) => {
    await writer.append('unit:0', { text: 'generation' })
  })
  await legacy.removeForFile(identity.fileId)
  expect(await (await store.open(generation)).read('unit:0')).toEqual({ text: 'generation' })
  expect(await legacy.totalBytes()).toBeGreaterThanOrEqual(generation.bytes)
})
