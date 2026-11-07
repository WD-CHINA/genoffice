import { StorageBudget } from '../src/storage-budget'
import { FileLifecycle } from '../src/file-lifecycle'
import { mkdir, mkdtemp, rm, open, readdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  ArtifactStore,
  artifactKey,
  canonicalJson,
  type ArtifactIdentity,
} from '../src/artifact-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup(maxBytes?: number) {
  const dir = await mkdtemp(join(tmpdir(), 'artifact-test-'))
  directories.push(dir)
  return { dir, store: new ArtifactStore(dir, maxBytes) }
}
const identity: ArtifactIdentity = {
  fileId: 'a'.repeat(64),
  format: 'pptx',
  parserFingerprint: 'build1',
  schemaVersion: 1,
  options: {},
}

it('legacy listing preserves misplaced unmanaged keys without resolving a different canonical directory', async () => {
  const { dir, store } = await setup()
  await mkdir(join(dir, 'artifacts', 'aa', 'c'.repeat(64)), { recursive: true })
  expect(await store.list()).toEqual([])
  await store.removeForFile(identity.fileId)
  expect(await readdir(join(dir, 'artifacts', 'aa'))).toEqual(['c'.repeat(64)])
})

it('canonicalizes option order and isolates parser/schema changes', () => {
  expect(artifactKey({ ...identity, options: { a: 1, b: 2 } })).toBe(
    artifactKey({ ...identity, options: { b: 2, a: 1 } }),
  )
  expect(artifactKey({ ...identity, parserFingerprint: 'build2' })).not.toBe(artifactKey(identity))
  expect(artifactKey({ ...identity, schemaVersion: 2 })).not.toBe(artifactKey(identity))
  for (const value of [new Map(), new Set(), undefined, NaN, Infinity, new Date()]) {
    expect(() => canonicalJson({ value })).toThrow('artifact DTO')
  }
})

it('publishes models and binary fonts once and reads them after store restart', async () => {
  const { dir, store } = await setup()
  let builds = 0
  const requests = Array.from({ length: 3 }, () =>
    store.getOrBuild(identity, async (writer) => {
      builds++
      await writer.append('document', {
        slides: 1,
        resource: { fileId: identity.fileId, partPath: 'ppt/media/a.png' },
      })
      await writer.append('unit:0', { slide: { elements: [{ text: 'hello' }] }, playback: [] })
      await writer.append('font:0', new Uint8Array([1, 2, 3]))
      expect(await store.find(artifactKey(identity))).toBeNull()
    }),
  )
  const readers = await Promise.all(requests)
  expect(builds).toBe(1)
  expect(await readers[0].read('font:0')).toEqual(Buffer.from([1, 2, 3]))
  const restarted = new ArtifactStore(dir)
  const cached = await restarted.getOrBuild(identity, async () => {
    throw new Error('must not rebuild')
  })
  expect(await cached.read('unit:0')).toEqual({
    slide: { elements: [{ text: 'hello' }] },
    playback: [],
  })
})

it('aborts failed builds, removes staging data and permits a clean retry', async () => {
  const { dir, store } = await setup()
  await expect(
    store.getOrBuild(identity, async (writer) => {
      await writer.append('unit:0', { partial: true })
      throw new Error('disk failure')
    }),
  ).rejects.toThrow('disk failure')
  expect(await store.find(artifactKey(identity))).toBeNull()
  expect(await readdir(join(dir, 'staging'))).toEqual([])
  const reader = await store.getOrBuild(identity, async (writer) => {
    await writer.append('unit:0', { complete: true })
  })
  expect(await reader.read('unit:0')).toEqual({ complete: true })
})

it('rejects oversized and duplicate records', async () => {
  const { store } = await setup(32)
  await expect(
    store.getOrBuild(identity, async (writer) => {
      await writer.append('large', 'x'.repeat(33))
    }),
  ).rejects.toThrow('byte budget')
  await expect(
    store.getOrBuild(identity, async (writer) => {
      await writer.append('same', {})
      await writer.append('same', {})
    }),
  ).rejects.toThrow('duplicate')
  expect(await store.find(artifactKey(identity))).toBeNull()
})

it('detects truncated and tampered artifacts rather than serving partial data', async () => {
  const { store } = await setup()
  const reader = await store.getOrBuild(identity, async (writer) => {
    await writer.append('unit:0', { data: 'original' })
  })
  const file = await open(join(reader.directory, 'units.bin'), 'r+')
  try {
    await file.truncate(1)
  } finally {
    await file.close()
  }
  await expect(store.find(artifactKey(identity))).rejects.toThrow('length mismatch')
  await expect(reader.read('unit:0')).rejects.toThrow('truncated')
})

it('rejects path traversal through invalid artifact identities', async () => {
  const { store } = await setup()
  await expect(store.find('../file')).rejects.toThrow('invalid artifact key')
  expect(() => artifactKey({ ...identity, fileId: '../file' })).toThrow('identity')
})

it('rebuilds corrupt manifests and missing data once under concurrent reopen', async () => {
  const { store } = await setup()
  let builds = 0
  const build = async (writer: import('../src/artifact-store').ArtifactWriter) => {
    builds++
    await writer.append('unit:0', { generation: builds })
  }
  let reader = await store.getOrBuild(identity, build)
  await writeFile(join(reader.directory, 'manifest.json'), '{broken')
  const reopened = await Promise.all(
    Array.from({ length: 5 }, () => store.getOrBuild(identity, build)),
  )
  expect(builds).toBe(2)
  expect(await reopened[0].read('unit:0')).toEqual({ generation: 2 })
  reader = reopened[0]
  await rm(join(reader.directory, 'units.bin'))
  reader = await store.getOrBuild(identity, build)
  expect(builds).toBe(3)
  expect(await reader.read('unit:0')).toEqual({ generation: 3 })
})

it('invalidates a same-length corrupt frame and rebuilds on the next open', async () => {
  const { store } = await setup()
  let builds = 0
  const build = async (writer: import('../src/artifact-store').ArtifactWriter) => {
    builds++
    await writer.append('unit:0', { intact: true })
  }
  const reader = await store.getOrBuild(identity, build)
  const file = await open(join(reader.directory, 'units.bin'), 'r+')
  try {
    await file.write(Buffer.from([0]), 0, 1, 0)
  } finally {
    await file.close()
  }
  await expect(reader.read('unit:0')).rejects.toThrow('compression invalid')
  const repaired = await store.getOrBuild(identity, build)
  expect(builds).toBe(2)
  expect(await repaired.read('unit:0')).toEqual({ intact: true })
})

it('validates cached metadata before declaring a hit and shares its repair', async () => {
  const { store } = await setup()
  let builds = 0
  const build = async (writer: import('../src/artifact-store').ArtifactWriter) => {
    builds++
    await writer.append('document', { valid: true })
  }
  const reader = await store.getOrBuild(identity, build)
  const file = await open(join(reader.directory, 'units.bin'), 'r+')
  try {
    await file.write(Buffer.from([0]), 0, 1, 0)
  } finally {
    await file.close()
  }
  const reopened = await Promise.all(
    Array.from({ length: 4 }, () =>
      store.getOrBuild(identity, build, undefined, async (cached) => {
        await cached.read('document')
      }),
    ),
  )
  expect(builds).toBe(2)
  expect(await reopened[0].read('document')).toEqual({ valid: true })
})

it('rejects artifact data or manifest writes before quota overflow and cleans staging reservations', async () => {
  const { dir } = await setup()
  const lock = new FileLifecycle()
  const budget: StorageBudget = new StorageBudget(
    100,
    async () => store.totalBytes(),
    (work) => lock.withFile('storage', work),
  )
  const store: ArtifactStore = new ArtifactStore(dir, undefined, budget)
  await expect(
    store.getOrBuild(identity, async (writer) => {
      await writer.append('unit:0', { text: 'small data but manifest exceeds quota' })
    }),
  ).rejects.toMatchObject({ code: 'storage_full' })
  expect(budget.reservedBytes).toBe(0)
  expect(await store.find(artifactKey(identity))).toBeNull()
  expect(await readdir(join(dir, 'staging'))).toEqual([])
})

it('counts corrupt artifact bytes without trusting the index and skips unknown eviction ownership', async () => {
  const { store } = await setup()
  const reader = await store.getOrBuild(identity, async (writer) => {
    await writer.append('unit:0', { text: 'kept' })
  })
  const before = await store.totalBytes()
  await writeFile(join(reader.directory, 'manifest.json'), '{bad')
  expect(await store.totalBytes()).toBeGreaterThan(4)
  expect(await store.totalBytes()).toBeLessThan(before)
  expect(await store.evictionCandidates('build1')).toEqual([])
})

it('evicts old parser versions first and persists coalesced last-access ordering across restart', async () => {
  const { dir, store } = await setup()
  const a = await store.getOrBuild(identity, async (writer) => {
    await writer.append('unit:0', 'a')
  })
  const other = { ...identity, fileId: 'b'.repeat(64) }
  const b = await store.getOrBuild(other, async (writer) => {
    await writer.append('unit:0', 'b')
  })
  const oldIdentity = { ...identity, parserFingerprint: 'old' }
  const old = await store.getOrBuild(oldIdentity, async (writer) => {
    await writer.append('unit:0', 'old')
  })
  await utimes(b.directory, new Date(0), new Date(0))
  await a.read('unit:0')
  const candidates = await new ArtifactStore(dir).evictionCandidates('build1')
  expect(candidates.map((entry) => entry.key)).toEqual([
    old.manifest.key,
    b.manifest.key,
    a.manifest.key,
  ])
  const before = await store.totalBytes()
  const removed = await store.evict(old.manifest.key)
  expect(removed).toBeGreaterThan(0)
  expect(await store.totalBytes()).toBe(before - removed)
  expect(await store.find(old.manifest.key)).toBeNull()
  expect(await a.read('unit:0')).toBe('a')
})

it('staging collection preserves an active build even when its directory is aged', async () => {
  const { store, dir } = await setup()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const building = store.getOrBuild(identity, async (writer) => {
    await writer.append('document', { intact: true })
    entered()
    await gate
  })
  try {
    await started
    const [name] = await readdir(join(dir, 'staging'))
    await utimes(join(dir, 'staging', name), new Date(0), new Date(0))
    expect(await store.cleanupStaging(1)).toBe(0)
  } finally {
    release()
  }
  expect(await (await building).read('document')).toEqual({ intact: true })
})

it('drains dependency acquisition before a later build and protects its source for the whole task', async () => {
  const { store } = await setup()
  let grant!: () => void
  let finish!: () => void
  let arrived!: () => void
  const dependency = new Promise<void>((resolve) => { grant = resolve })
  const cleanup = new Promise<void>((resolve) => { finish = resolve })
  const admitted = new Promise<void>((resolve) => { arrived = resolve })
  const task = store.runOwned(identity.fileId, async () => {
    await dependency
    return store.getOrBuild(identity, async (writer) => {
      arrived()
      await cleanup
      await writer.append('unit:0', { complete: true })
    })
  })
  let drained = false
  const draining = store.drain().then(() => { drained = true })
  try {
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(store.activeFileIds.has(identity.fileId)).toBe(true)
    grant()
    await admitted
    expect(drained).toBe(false)
    expect(store.activeFileIds.has(identity.fileId)).toBe(true)
  } finally { grant(); finish(); await task; await draining }
  expect(drained).toBe(true)
  expect(store.activeFileIds.has(identity.fileId)).toBe(false)
})

it('observes failed owned dependency acquisition and removes its source reference', async () => {
  const { store } = await setup()
  const task = store.runOwned(identity.fileId, async () => { throw new Error('dependency failed') })
  await expect(task).rejects.toThrow('dependency failed')
  await store.drain()
  expect(store.activeFileIds.size).toBe(0)
})
