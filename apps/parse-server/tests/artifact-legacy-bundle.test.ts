import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import type { OfflineBundleManifest, OfflineBundleResource } from '@genoffice/parse-contract'
import {
  ArtifactSession, MODEL_SCHEMA_VERSION, type ArtifactSessionInput,
} from '../src/artifact-session'
import { writeOfflineBundle } from '../src/offline-bundle'
import {
  ArtifactStore, ArtifactCorruptionError, artifactKey,
  type ArtifactIdentity, type JsonValue,
} from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import type {
  MysqlArtifactCatalog, ReadyArtifact, ArtifactClaim, ArtifactLease, ArtifactReadLease,
} from '../src/artifact-catalog'
import { DEFAULT_LIMITS } from '../src/limits'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length) await cleanup.pop()!()
})

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const MEDIA_PATH = 'parts/ppt/media/image1.bin'
const PART_ID = 'bundle:part:ppt/media/image1.bin'
const MEDIA = { path: MEDIA_PATH, size: 5, sha256: sha('media') }
const LAYOUT = {
  size: { cx: 9144000, cy: 6858000 },
  slideCount: 1,
  parserVersion: 'test',
  fonts: [],
}
const LEGACY_MODEL: Array<[string, JsonValue]> = [
  ['document', {
    model: { format: 'pptx', unitCount: 1, generation: 9 },
    fonts: [],
    layout: LAYOUT,
  } as unknown as JsonValue],
  ['unit:0', { text: 'legacy-model' }],
  ['external-media', []],
]

interface FlatDraft {
  resources: OfflineBundleResource[]
  partRecord: { path: string; size: number; sha256: string } | null
  artifactKey: string
  modelArtifactKey: string
  bundleSchemaVersion: number
  modelSchemaVersion: number
}

interface Harness {
  root: string
  input: ArtifactSessionInput
  store: ArtifactStore
  catalog: Record<string, unknown>
  backend: { catalog: MysqlArtifactCatalog; disk: ArtifactGenerations; coordinator: ArtifactCoordinator }
  sessions: ArtifactSession[]
  modelKey: string
  bundleKey: string
  ready(key: string): ReadyArtifact | undefined
  legacyBundleDir(): string
  sourceBuild(): ReturnType<typeof vi.spyOn>
  open(): Promise<ArtifactSession>
  damageFlat(id: string): Promise<void>
  rewriteFlat(mutate: (draft: FlatDraft) => void): Promise<void>
  seedRealFlatBundle(): Promise<void>
}

/**
 * Simulate an upgrade from the old local backend: both the model and its
 * offline bundle already exist as flat artifacts, and neither may be rebuilt
 * from the source. The catalog backend should import both into generations.
 */
async function setup(options: { withLegacyBundle?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'artifact-legacy-bundle-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const input: ArtifactSessionInput = {
    id: randomUUID(), fileId: 'c'.repeat(64), path: join(root, 'source.pptx'), width: 960,
    parserVersion: 'test', parserFingerprint: 'legacy-bundle', baseUrl: 'http://localhost',
    format: 'pptx', chunkRoot: join(root, 'chunks'), limits: DEFAULT_LIMITS,
    parseTimeoutMs: 10_000, unitTimeoutMs: 10_000, workerMemoryMb: 128, workerRssMb: 512,
    processGroup: randomUUID(),
  }
  await writeFile(input.path, Buffer.from(await createBlankPptx()))
  const store = new ArtifactStore(root)
  const modelIdentity = ArtifactSession.identity(input)
  const modelKey = artifactKey(modelIdentity)
  // The old flat model artifact; importLegacy will copy it to generation 1.
  await store.getOrBuild(modelIdentity, async (writer) => {
    for (const [id, value] of LEGACY_MODEL) await writer.append(id, value)
  })
  const modelReader = (await store.find(modelKey))!
  const unitDescriptor = modelReader.describe('unit:0')
  // Mirror ArtifactSession.bundleIdentity(): the derived key binds the model's
  // generation key and content digest, so a stale model cannot be imported.
  const bundleIdentity: ArtifactIdentity = {
    ...modelIdentity,
    options: {
      purpose: 'offline-bundle',
      modelArtifactKey: modelReader.manifest.key,
      modelContentDigest: modelReader.contentDigest,
    },
  }
  const bundleKey = artifactKey(bundleIdentity)

  const rewriteFlat = async (mutate: (draft: FlatDraft) => void): Promise<void> => {
    const draft: FlatDraft = {
      resources: [
        { path: 'layout.json', size: 0, sha256: '' },
        { path: 'layout/0.json', ...unitDescriptor },
        { ...MEDIA },
      ],
      partRecord: { ...MEDIA },
      artifactKey: bundleKey,
      modelArtifactKey: modelKey,
      bundleSchemaVersion: 1,
      modelSchemaVersion: MODEL_SCHEMA_VERSION,
    }
    mutate(draft)
    await store.evict(bundleKey)
    await store.getOrBuild(bundleIdentity, async (writer) => {
      await writer.append('bundle:layout', LAYOUT as unknown as JsonValue)
      if (draft.partRecord) await writer.append(PART_ID, draft.partRecord as unknown as JsonValue)
      const layout = writer.describe('bundle:layout')
      const resources = draft.resources.map((resource) =>
        resource.path === 'layout.json' ? { ...resource, ...layout } : resource)
      const manifest = {
        bundleSchemaVersion: draft.bundleSchemaVersion,
        modelSchemaVersion: draft.modelSchemaVersion,
        artifactKey: draft.artifactKey,
        modelArtifactKey: draft.modelArtifactKey,
        fileId: input.fileId,
        format: 'pptx',
        parserVersion: input.parserVersion,
        parserFingerprint: input.parserFingerprint,
        unitCount: 1,
        fonts: [],
        inventory: 'ppt-media-v1',
        totalBytes: resources.reduce((sum, resource) => sum + resource.size, 0),
        resources,
        externalResources: [],
      } as unknown as OfflineBundleManifest
      await writer.append('bundle', manifest as unknown as JsonValue)
    })
  }
  /** A genuinely historical flat bundle, produced by the real writer against a real ZIP. */
  const seedRealFlatBundle = async (): Promise<void> => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    const media = Buffer.from('streamed media '.repeat(200))
    zip.file('ppt/media/stored.bin', media, { compression: 'STORE' })
    zip.file('ppt/media/deflated.bin', media, { compression: 'DEFLATE' })
    zip.file('ppt/media/音 频.bin', Buffer.from('unicode path'), { compression: 'STORE' })
    await writeFile(input.path, await zip.generateAsync({ type: 'nodebuffer' }))
    await store.evict(bundleKey)
    await store.getOrBuild(bundleIdentity, (writer) => writeOfflineBundle(
      writer,
      {
        path: input.path,
        fileId: input.fileId,
        artifactKey: bundleKey,
        modelArtifactKey: modelKey,
        modelSchemaVersion: MODEL_SCHEMA_VERSION,
        parserVersion: input.parserVersion,
        parserFingerprint: input.parserFingerprint,
        limits: DEFAULT_LIMITS,
      },
      LAYOUT as unknown as Parameters<typeof writeOfflineBundle>[2],
      new Set<string>(),
      (id) => modelReader.describe(id),
    ))
  }
  if (options.withLegacyBundle !== false) await rewriteFlat(() => undefined)

  const rows = new Map<string, { generation: number; ready?: ReadyArtifact }>()
  const catalog = {
    leaseMs: 30_000,
    claim: vi.fn(async (identity: ArtifactIdentity, owner: string): Promise<ArtifactClaim> => {
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
  const disk = new ArtifactGenerations(root)
  const coordinator = new ArtifactCoordinator(catalog, disk, 5, 2000)
  cleanup.push(() => coordinator.close())
  const sessions: ArtifactSession[] = []
  cleanup.push(async () => { for (const session of sessions.splice(0)) await session.dispose() })
  // Neither the model nor the bundle may ever be parsed from the source here.
  const sourceBuild = vi.spyOn(ArtifactSession, 'build').mockImplementation(async () => {
    throw new Error('source parse must not run for a verified flat artifact')
  })
  const backend = {
    catalog: catalog as unknown as MysqlArtifactCatalog, disk, coordinator,
  }
  return {
    root, input, store, catalog, backend, sessions, modelKey, bundleKey,
    ready: (key) => rows.get(key)?.ready,
    legacyBundleDir: () => join(root, 'artifacts', bundleKey.slice(0, 2), bundleKey),
    sourceBuild: () => sourceBuild,
    open: async () => {
      const session = await ArtifactSession.openShared(store, input, backend)
      sessions.push(session)
      return session
    },
    damageFlat: async (id: string) => {
      const directory = join(root, 'artifacts', bundleKey.slice(0, 2), bundleKey)
      const manifest = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8'),
      ) as { records: Array<{ id: string; offset: number; length: number }> }
      const entry = manifest.records.find((record) => record.id === id)!
      const position = entry.offset + Math.floor(entry.length / 2)
      const handle = await open(join(directory, 'units.bin'), 'r+')
      try {
        const byte = Buffer.alloc(1)
        await handle.read(byte, 0, 1, position)
        byte[0] ^= 0xff
        await handle.write(byte, 0, 1, position)
      } finally { await handle.close() }
    },
    rewriteFlat,
    seedRealFlatBundle,
  }
}

it('imports a verified flat bundle into a generation without rebuilding the bundle', async () => {
  const h = await setup()
  const session = await h.open()
  const manifest = await session.bundleManifest()
  expect(h.sourceBuild()).not.toHaveBeenCalled()
  // A real bundle build must fork the model read lease; importing does not.
  expect(h.catalog.forkRead).not.toHaveBeenCalled()
  expect(h.store.stats.legacyImports).toBe(1)
  expect(h.store.stats.legacyBundleImports).toBe(1)
  expect(h.store.stats.sourceParsesStarted).toBe(0)
  expect(manifest.artifactKey).toBe(h.bundleKey)
  expect(manifest.resources.map((resource) => resource.path)).toEqual([
    'layout.json', 'layout/0.json', MEDIA_PATH,
  ])
  const ready = h.ready(h.bundleKey)!
  expect(ready.generation).toBe(1)
  await expect(stat(join(h.root, ready.storagePath, 'manifest.json'))).resolves.toBeDefined()
  // The import leaves the old flat files for the existing TTL/GC retirement.
  await expect(stat(join(h.legacyBundleDir(), 'manifest.json'))).resolves.toBeDefined()
  await expect(stat(join(h.legacyBundleDir(), 'units.bin'))).resolves.toBeDefined()
  // Derived records are served from the imported generation.
  expect((await session.bundleResource('layout.json'))?.bytes?.length).toBeGreaterThan(0)
  expect(await session.bundleResource(MEDIA_PATH)).toMatchObject({
    info: { path: MEDIA_PATH, size: MEDIA.size, sha256: MEDIA.sha256 },
    partPath: 'ppt/media/image1.bin',
  })
  await session.dispose()
})

it('imports a real flat bundle produced by writeOfflineBundle, frame for frame', async () => {
  const h = await setup()
  await h.seedRealFlatBundle()
  const flat = await h.store.find(h.bundleKey)
  expect(flat).not.toBeNull()
  const session = await h.open()
  const manifest = await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(1)
  expect(h.catalog.forkRead).not.toHaveBeenCalled()
  expect(h.sourceBuild()).not.toHaveBeenCalled()
  expect(manifest.artifactKey).toBe(h.bundleKey)
  expect(manifest.resources.map((resource) => resource.path)).toEqual(expect.arrayContaining([
    'layout.json', 'layout/0.json',
    'parts/ppt/media/stored.bin',
    'parts/ppt/media/deflated.bin',
    'parts/ppt/media/音 频.bin',
  ]))
  const generation = await h.backend.disk.open(h.ready(h.bundleKey)!)
  expect(generation.manifest.records.map((entry) => entry.id)).toEqual(
    flat!.manifest.records.map((entry) => entry.id),
  )
  for (const entry of flat!.manifest.records)
    expect(await generation.read(entry.id)).toEqual(await flat!.read(entry.id))
  expect(await session.bundleResource('parts/ppt/media/音 频.bin')).toMatchObject({
    partPath: 'ppt/media/音 频.bin',
  })
  await session.dispose()
})

it('shares exactly one bundle import across concurrent views', async () => {
  const h = await setup()
  const [first, second] = await Promise.all([h.open(), h.open()])
  const [a, b] = await Promise.all([first.bundleManifest(), second.bundleManifest()])
  expect(a).toEqual(b)
  expect(h.store.stats.legacyBundleImports).toBe(1)
  expect(h.ready(h.bundleKey)!.generation).toBe(1)
  expect(h.catalog.complete).toHaveBeenCalledTimes(2) // model + bundle
  expect(h.catalog.forkRead).not.toHaveBeenCalled()
})

it('falls back to a real bundle build when a flat frame fails verification', async () => {
  const h = await setup()
  await h.damageFlat(PART_ID)
  const session = await h.open()
  const manifest = await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(0)
  expect(h.sourceBuild()).not.toHaveBeenCalled() // the model is still imported
  expect(h.catalog.forkRead).toHaveBeenCalled() // a real bundle build forks the model pin
  expect(manifest.artifactKey).toBe(h.bundleKey)
  expect(h.ready(h.bundleKey)!.generation).toBe(1)
  expect(h.store.stats.legacyImports).toBe(1)
})

it('rejects a flat bundle whose inventory disagrees with its derived record', async () => {
  const h = await setup()
  await h.rewriteFlat((draft) => {
    draft.partRecord = { ...draft.partRecord!, sha256: 'f'.repeat(64) }
  })
  const session = await h.open()
  await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(0)
  expect(h.catalog.forkRead).toHaveBeenCalled()
})

it('rejects an undeclared derived record', async () => {
  const h = await setup()
  await h.rewriteFlat((draft) => {
    draft.resources = draft.resources.filter((resource) => resource.path !== MEDIA_PATH)
  })
  const session = await h.open()
  await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(0)
  expect(h.catalog.forkRead).toHaveBeenCalled()
})

it('rejects a missing derived record declared by the inventory', async () => {
  const h = await setup()
  await h.rewriteFlat((draft) => { draft.partRecord = null })
  const session = await h.open()
  await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(0)
  expect(h.catalog.forkRead).toHaveBeenCalled()
})

it('falls back for a damaged flat manifest or a stale/mismatched schema', async () => {
  const damaged = await setup()
  await writeFile(join(damaged.legacyBundleDir(), 'manifest.json'), '{damaged')
  await (await damaged.open()).bundleManifest()
  expect(damaged.store.stats.legacyBundleImports).toBe(0)

  const stale = await setup()
  await stale.rewriteFlat((draft) => { draft.bundleSchemaVersion = 0 })
  await (await stale.open()).bundleManifest()
  expect(stale.store.stats.legacyBundleImports).toBe(0)

  const wrongKey = await setup()
  await wrongKey.rewriteFlat((draft) => { draft.artifactKey = 'd'.repeat(64) })
  await (await wrongKey.open()).bundleManifest()
  expect(wrongKey.store.stats.legacyBundleImports).toBe(0)
})

it('does not mistake a generation-only directory for a flat bundle', async () => {
  const h = await setup({ withLegacyBundle: false })
  const directory = h.legacyBundleDir()
  await mkdir(join(directory, 'g-99'), { recursive: true })
  await writeFile(join(directory, 'g-99', 'manifest.json'), '{}')
  const session = await h.open()
  await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(0)
  expect(h.catalog.forkRead).toHaveBeenCalled()
  expect(h.ready(h.bundleKey)!.generation).toBe(1)
})

it('never imports a flat bundle whose identity no longer matches its key', async () => {
  const h = await setup()
  const directory = h.legacyBundleDir()
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>
  manifest.identity = { ...(manifest.identity as object), options: { changed: true } }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(h.store.find(h.bundleKey)).rejects.toBeInstanceOf(ArtifactCorruptionError)
  const session = await h.open()
  await session.bundleManifest()
  expect(h.store.stats.legacyBundleImports).toBe(0)
  expect(h.catalog.forkRead).toHaveBeenCalled()
})
