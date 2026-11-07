import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { ArtifactSession, type ArtifactSessionInput } from '../src/artifact-session'
import {
  ArtifactStore, ArtifactCorruptionError, artifactKey, type ArtifactWriter, type ArtifactIdentity,
} from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import { ArtifactReadHandle } from '../src/artifact-read-handle'
import type {
  MysqlArtifactCatalog, ReadyArtifact, ArtifactClaim, ArtifactLease, ArtifactReadLease,
} from '../src/artifact-catalog'
import { DEFAULT_LIMITS } from '../src/limits'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length) await cleanup.pop()!()
})

interface Harness {
  root: string
  input: ArtifactSessionInput
  store: ArtifactStore
  disk: ArtifactGenerations
  catalog: Record<string, unknown>
  backend: { catalog: MysqlArtifactCatalog; disk: ArtifactGenerations; coordinator: ArtifactCoordinator }
  sessions: ArtifactSession[]
  modelKey: string
  bundleKey(): string
  ready(key: string): ReadyArtifact | undefined
  builds(): number
  failNextBundlePin(): void
  open(): Promise<ArtifactSession>
}

/** In-memory catalog faithful enough to distinguish the model and bundle artifact rows. */
async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'artifact-shared-bundle-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const input: ArtifactSessionInput = {
    id: randomUUID(), fileId: 'b'.repeat(64), path: join(root, 'source.pptx'), width: 960,
    parserVersion: 'test', parserFingerprint: 'shared-bundle', baseUrl: 'http://localhost',
    format: 'pptx', chunkRoot: join(root, 'chunks'), limits: DEFAULT_LIMITS,
    parseTimeoutMs: 10_000, unitTimeoutMs: 10_000, workerMemoryMb: 128, workerRssMb: 512,
    processGroup: randomUUID(),
  }
  await writeFile(input.path, Buffer.from(await createBlankPptx()))
  const store = new ArtifactStore(root)
  const disk = new ArtifactGenerations(root)
  const modelKey = artifactKey(ArtifactSession.identity(input))
  const claimed: ArtifactIdentity[] = []
  const rows = new Map<string, { generation: number; ready?: ReadyArtifact }>()
  let failBundlePin = false

  const catalog = {
    leaseMs: 30_000,
    claim: vi.fn(async (identity: ArtifactIdentity, owner: string): Promise<ArtifactClaim> => {
      claimed.push(identity)
      const key = artifactKey(identity)
      const row = rows.get(key) ?? { generation: 0 }
      rows.set(key, row)
      if (row.ready) return { kind: 'ready', artifact: row.ready }
      return { kind: 'acquired', lease: { key, owner, jobId: randomUUID(),
        generation: ++row.generation, leaseUntil: Date.now() + 30_000 } }
    }),
    renew: vi.fn(async (_lease: ArtifactLease) => true),
    complete: vi.fn(async (lease: ArtifactLease, summary: {
      bytes: number; unitCount: number; manifestSha256: string
    }) => {
      const row = rows.get(lease.key)!
      row.ready = { ...summary, key: lease.key, generation: lease.generation,
        storagePath: `artifacts/${lease.key.slice(0, 2)}/${lease.key}/g-${lease.generation}` }
      return true
    }),
    fail: vi.fn(async (_lease: ArtifactLease, _code: string) => true),
    invalidateReady: vi.fn(async (expected: ReadyArtifact) => {
      const row = rows.get(expected.key)
      if (row?.ready && row.ready.generation === expected.generation &&
          row.ready.manifestSha256 === expected.manifestSha256) { row.ready = undefined; return true }
      return false
    }),
    pin: vi.fn(async (key: string, owner: string, durationMs?: number) => {
      // Simulate a concurrent withdrawal between SQL readiness and the view's pin.
      if (key !== modelKey && failBundlePin) { failBundlePin = false; return null }
      const ready = rows.get(key)?.ready
      if (!ready) return null
      return { artifact: ready, lease: { key, generation: ready.generation, owner,
        id: randomUUID(), leaseUntil: Date.now() + (durationMs ?? 30_000) } }
    }),
    forkRead: vi.fn(async (source: ArtifactReadLease, owner: string, durationMs?: number) => ({
      ...source, id: randomUUID(), owner, leaseUntil: Date.now() + (durationMs ?? 30_000),
    })),
    renewRead: vi.fn(async (_lease: ArtifactReadLease) => true),
    releaseRead: vi.fn(async (_lease: ArtifactReadLease) => true),
  }
  const coordinator = new ArtifactCoordinator(catalog, disk, 5, 2000)
  cleanup.push(() => coordinator.close())
  const sessions: ArtifactSession[] = []
  cleanup.push(async () => { for (const session of sessions.splice(0)) await session.dispose() })

  let builds = 0
  // Deterministic model records; the bundle itself is built by the real writer
  // against the archived source file, so generation records contain real frames.
  vi.spyOn(ArtifactSession, 'build').mockImplementation(
    async (_store: ArtifactStore, _input: ArtifactSessionInput, writer: ArtifactWriter) => {
      builds++
      await writer.append('document', {
        model: { format: 'pptx', unitCount: 1, generation: builds },
        fonts: [],
        layout: {
          size: { cx: 9144000, cy: 6858000 }, slideCount: 1,
          parserVersion: 'test', fonts: [],
        },
      })
      await writer.append('unit:0', { text: `generation-${builds}` })
      await writer.append('external-media', [])
    },
  )

  const backend = {
    catalog: catalog as unknown as MysqlArtifactCatalog, disk, coordinator,
  }
  return {
    root, input, store, disk, catalog, backend, sessions, modelKey,
    bundleKey: () => {
      const identity = claimed.find((item) =>
        (item.options as { purpose?: string }).purpose === 'offline-bundle')
      if (!identity) throw new Error('offline bundle identity was never claimed')
      return artifactKey(identity)
    },
    ready: (key) => rows.get(key)?.ready,
    builds: () => builds,
    failNextBundlePin: () => { failBundlePin = true },
    open: async () => {
      const session = await ArtifactSession.openShared(store, input, backend)
      sessions.push(session)
      return session
    },
  }
}

/** Corrupt exactly one persisted frame without touching the manifest or other records. */
async function damage(h: Harness, ready: ReadyArtifact, id: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(h.root, ready.storagePath, 'manifest.json'), 'utf8'),
  ) as { records: Array<{ id: string; offset: number; length: number }> }
  const entry = manifest.records.find((record) => record.id === id)
  if (!entry) throw new Error(`missing record ${id}`)
  const position = entry.offset + Math.floor(entry.length / 2)
  const handle = await open(join(h.root, ready.storagePath, 'units.bin'), 'r+')
  try {
    const byte = Buffer.alloc(1)
    await handle.read(byte, 0, 1, position)
    byte[0] ^= 0xff
    await handle.write(byte, 0, 1, position)
  } finally { await handle.close() }
}

it('publishes the offline bundle as its own generation with a separate read lease', async () => {
  const h = await setup()
  const session = await h.open()
  const manifest = await session.bundleManifest()
  const key = h.bundleKey()
  const ready = h.ready(key)!
  expect(ready).toBeDefined()
  expect(ready.key).not.toBe(h.modelKey)
  expect(ready.generation).toBe(1)
  expect(manifest.artifactKey).toBe(key)
  expect(manifest.resources.map((resource) => resource.path)).toContain('layout.json')
  // Immutable generation layout, not the legacy flat artifact directory.
  await expect(stat(join(h.root, ready.storagePath, 'manifest.json'))).resolves.toBeDefined()
  await expect(stat(join(h.root, 'artifacts', key.slice(0, 2), key, 'units.bin'))).rejects.toMatchObject(
    { code: 'ENOENT' },
  )
  expect(h.catalog.complete).toHaveBeenCalledTimes(2)
  expect(h.catalog.pin).toHaveBeenCalledWith(h.modelKey, expect.any(String), expect.any(Number))
  expect(h.catalog.pin).toHaveBeenCalledWith(key, expect.stringMatching(/^bundle:/), expect.any(Number))
  // The model generation stays pinned for the whole derived build.
  expect(h.catalog.forkRead).toHaveBeenCalledTimes(1)
  await session.dispose()
  expect(h.catalog.releaseRead).toHaveBeenCalledWith(expect.objectContaining({ key }))
  expect(h.catalog.releaseRead).toHaveBeenCalledWith(expect.objectContaining({ key: h.modelKey }))
})

it('reuses the ready bundle generation across views and keeps pins independent', async () => {
  const h = await setup()
  const first = await h.open()
  const second = await h.open()
  const before = await first.bundleManifest()
  const key = h.bundleKey()
  await first.dispose()
  const after = await second.bundleManifest()
  expect(after.artifactKey).toBe(before.artifactKey)
  expect(h.ready(key)!.generation).toBe(1)
  expect(h.catalog.complete).toHaveBeenCalledTimes(2)
  expect(h.store.stats.buildsStarted).toBe(2) // one model build + one bundle build
  expect(h.catalog.releaseRead).toHaveBeenCalledWith(expect.objectContaining({ key }))
  expect(await second.bundleResource('layout.json')).not.toBeNull()
})

it('rebuilds a damaged bundle frame once and retries in the already-open view', async () => {
  const h = await setup()
  const session = await h.open()
  await session.bundleManifest()
  const key = h.bundleKey()
  const first = h.ready(key)!
  await damage(h, first, 'bundle')

  const repaired = await session.bundleManifest()
  expect(repaired.artifactKey).toBe(key)
  expect(h.ready(key)!.generation).toBe(2)
  expect(h.catalog.invalidateReady).toHaveBeenCalledWith(first)
  expect(h.catalog.complete).toHaveBeenCalledTimes(3)
  // Only the derived generation is repaired; the model generation is untouched.
  expect(h.ready(h.modelKey)!.generation).toBe(1)
  expect(h.builds()).toBe(1)
  await expect(stat(join(h.root, first.storagePath, 'manifest.json'))).resolves.toBeDefined()

  // A second independent damage must not loop into another rebuild.
  await damage(h, h.ready(key)!, 'bundle')
  await expect(session.bundleManifest()).rejects.toBeInstanceOf(ArtifactCorruptionError)
  expect(h.catalog.complete).toHaveBeenCalledTimes(3)
  await session.dispose()
})

it('deduplicates concurrent bundle repairs across views into one shared rebuild', async () => {
  const h = await setup()
  const first = await h.open()
  const second = await h.open()
  await Promise.all([first.bundleManifest(), second.bundleManifest()])
  const key = h.bundleKey()
  const broken = h.ready(key)!
  await damage(h, broken, 'bundle')

  const results = await Promise.all([first.bundleManifest(), second.bundleManifest()])
  expect(results.map((manifest) => manifest.artifactKey)).toEqual([key, key])
  expect(h.ready(key)!.generation).toBe(2)
  expect(h.catalog.complete).toHaveBeenCalledTimes(3)
  expect(h.builds()).toBe(1)
})

it('does not withdraw a bundle generation for an ordinary filesystem error', async () => {
  const h = await setup()
  const session = await h.open()
  await session.bundleManifest()
  const ioError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  vi.spyOn(ArtifactReadHandle.prototype, 'read').mockRejectedValueOnce(ioError)
  await expect(session.bundleManifest()).rejects.toMatchObject({ code: 'EACCES' })
  expect(h.catalog.invalidateReady).not.toHaveBeenCalled()
  expect(h.ready(h.bundleKey())!.generation).toBe(1)
  await session.dispose()
})

it('keeps model resources readable after the bundle generation is rebuilt', async () => {
  const h = await setup()
  const session = await h.open()
  await session.bundleManifest()
  const key = h.bundleKey()
  await damage(h, h.ready(key)!, 'bundle')
  await session.bundleManifest()
  const page = await session.bundleResource('layout/0.json')
  expect(page?.bytes?.toString()).toContain('generation-1')
  expect(h.ready(h.modelKey)!.generation).toBe(1)
  await session.dispose()
})

it('withdraws and rebuilds a damaged bundle manifest when a new view attaches', async () => {
  const h = await setup()
  const first = await h.open()
  await first.bundleManifest()
  const key = h.bundleKey()
  const broken = h.ready(key)!
  await first.dispose()
  await writeFile(join(h.root, broken.storagePath, 'manifest.json'), '{damaged')

  const second = await h.open()
  const manifest = await second.bundleManifest()
  expect(manifest.artifactKey).toBe(key)
  expect(h.ready(key)!.generation).toBe(2)
  expect(h.catalog.invalidateReady).toHaveBeenCalledWith(broken)
  expect(h.ready(h.modelKey)!.generation).toBe(1)
  await second.dispose()
})

it('retries the read lease when the ready bundle pointer disappears between publish and pin', async () => {
  const h = await setup()
  const session = await h.open()
  h.failNextBundlePin()
  const manifest = await session.bundleManifest()
  expect(manifest.artifactKey).toBe(h.bundleKey())
  expect(h.ready(h.bundleKey())!.generation).toBe(1)
  expect(h.catalog.complete).toHaveBeenCalledTimes(2)
  expect(h.catalog.pin).toHaveBeenCalledTimes(3)
  await session.dispose()
})
