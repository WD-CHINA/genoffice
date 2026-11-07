import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactSession, type ArtifactSessionInput } from '../src/artifact-session'
import {
  ArtifactStore, ArtifactCorruptionError, artifactKey, type ArtifactWriter, type JsonValue,
} from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import type { MysqlArtifactCatalog, ReadyArtifact, ArtifactClaim } from '../src/artifact-catalog'
import { DEFAULT_LIMITS } from '../src/limits'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length) await cleanup.pop()!()
})

const LEGACY_RECORDS: Array<[string, JsonValue]> = [
  ['document', { model: { format: 'pptx', unitCount: 1, generation: 7 }, fonts: [] }],
  ['unit:0', { text: 'legacy' }],
  ['external-media', []],
]

interface Harness {
  root: string
  input: ArtifactSessionInput
  identity: ReturnType<typeof ArtifactSession.identity>
  store: ArtifactStore
  disk: ArtifactGenerations
  catalog: Record<string, unknown>
  backend: { catalog: MysqlArtifactCatalog; disk: ArtifactGenerations; coordinator: ArtifactCoordinator }
  sessions: ArtifactSession[]
  ready(): ReadyArtifact | undefined
  legacyDir(): string
  open(): Promise<ArtifactSession>
  mockSourceBuild(): ReturnType<typeof vi.spyOn>
}

async function setup(options: { withLegacy?: boolean } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'artifact-legacy-import-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const input: ArtifactSessionInput = {
    id: randomUUID(), fileId: 'a'.repeat(64), path: join(root, 'source.pptx'), width: 960,
    parserVersion: 'test', parserFingerprint: 'legacy-import', baseUrl: 'http://localhost',
    format: 'pptx', chunkRoot: join(root, 'chunks'), limits: DEFAULT_LIMITS,
    parseTimeoutMs: 10_000, unitTimeoutMs: 10_000, workerMemoryMb: 128, workerRssMb: 512,
    processGroup: randomUUID(),
  }
  const identity = ArtifactSession.identity(input)
  const key = artifactKey(identity)
  const store = new ArtifactStore(root)
  if (options.withLegacy !== false) {
    await store.getOrBuild(identity, async (writer) => {
      for (const [id, value] of LEGACY_RECORDS) await writer.append(id, value)
    })
  }
  let ready: ReadyArtifact | undefined
  let generation = 0
  const catalog = {
    leaseMs: 30_000,
    claim: vi.fn(async (): Promise<ArtifactClaim> => ready
      ? { kind: 'ready', artifact: ready }
      : { kind: 'acquired', lease: { key, owner: 'test', jobId: randomUUID(),
          generation: ++generation, leaseUntil: Date.now() + 30_000 } }),
    renew: vi.fn(async () => true),
    complete: vi.fn(async (lease: { generation: number }, summary: {
      bytes: number; unitCount: number; manifestSha256: string
    }) => {
      ready = { ...summary, key, generation: lease.generation,
        storagePath: `artifacts/${key.slice(0, 2)}/${key}/g-${lease.generation}` }
      return true
    }),
    fail: vi.fn(async () => true),
    invalidateReady: vi.fn(async (expected: ReadyArtifact) => {
      if (ready && ready.generation === expected.generation &&
          ready.manifestSha256 === expected.manifestSha256) { ready = undefined; return true }
      return false
    }),
    pin: vi.fn(async (_key: string, owner: string, durationMs?: number) => ready
      ? { artifact: ready, lease: { key, generation: ready.generation, owner,
          id: randomUUID(), leaseUntil: Date.now() + (durationMs ?? 30_000) } }
      : null),
    renewRead: vi.fn(async () => true),
    releaseRead: vi.fn(async () => true),
  }
  const disk = new ArtifactGenerations(root)
  const coordinator = new ArtifactCoordinator(catalog, disk, 5, 2000)
  cleanup.push(() => coordinator.close())
  const sessions: ArtifactSession[] = []
  cleanup.push(async () => { for (const session of sessions.splice(0)) await session.dispose() })
  const backend = { catalog: catalog as unknown as MysqlArtifactCatalog, disk, coordinator }
  return {
    root, input, identity, store, disk, catalog, backend, sessions,
    ready: () => ready,
    legacyDir: () => join(root, 'artifacts', key.slice(0, 2), key),
    mockSourceBuild: () => vi.spyOn(ArtifactSession, 'build').mockImplementation(
      async (_store: ArtifactStore, _input: ArtifactSessionInput, writer: ArtifactWriter) => {
        for (const [id, value] of LEGACY_RECORDS) await writer.append(id, value)
      },
    ),
    open: async () => {
      const session = await ArtifactSession.openShared(store, input, backend)
      sessions.push(session)
      return session
    },
  }
}

/** Corrupt one frame of the legacy flat artifact without changing the manifest. */
async function damageLegacy(h: Harness, id: string): Promise<void> {
  const directory = h.legacyDir()
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as {
    records: Array<{ id: string; offset: number; length: number }>
  }
  const entry = manifest.records.find((record) => record.id === id)!
  const position = entry.offset + Math.floor(entry.length / 2)
  const handle = await open(join(directory, 'units.bin'), 'r+')
  try {
    const byte = Buffer.alloc(1)
    await handle.read(byte, 0, 1, position)
    byte[0] ^= 0xff
    await handle.write(byte, 0, 1, position)
  } finally { await handle.close() }
}

it('imports a verified flat artifact into a generation without parsing the source', async () => {
  const h = await setup()
  const parse = vi.spyOn(ArtifactSession, 'build').mockImplementation(async () => {
    throw new Error('source parse must not run for a verified legacy artifact')
  })
  const session = await h.open()
  expect(parse).not.toHaveBeenCalled()
  expect(h.store.stats.legacyImports).toBe(1)
  expect(h.store.stats.sourceParsesStarted).toBe(0)
  expect(h.catalog.complete).toHaveBeenCalledTimes(1)
  expect(h.ready()!.generation).toBe(1)
  expect(h.ready()!.unitCount).toBe(1)
  const reader = await h.disk.open(h.ready()!)
  expect(await reader.read('unit:0')).toEqual({ text: 'legacy' })
  expect((await reader.read('document') as { model: { generation: number } }).model.generation).toBe(7)
  // The import never deletes the original flat files; GC owns their retirement.
  await expect(stat(join(h.legacyDir(), 'manifest.json'))).resolves.toBeDefined()
  await session.dispose()
})

it('concurrent views share exactly one import instead of two source parses', async () => {
  const h = await setup()
  const parse = vi.spyOn(ArtifactSession, 'build').mockImplementation(async () => {
    throw new Error('source parse must not run')
  })
  const [first, second] = await Promise.all([h.open(), h.open()])
  expect(parse).not.toHaveBeenCalled()
  expect(h.store.stats.legacyImports).toBe(1)
  expect(h.catalog.complete).toHaveBeenCalledTimes(1)
  expect(h.ready()!.generation).toBe(1)
  expect(first.model).toEqual(second.model)
})

it('falls back to a real build when a legacy frame fails verification', async () => {
  const h = await setup()
  await damageLegacy(h, 'unit:0')
  const parse = h.mockSourceBuild()
  await h.open()
  expect(parse).toHaveBeenCalledTimes(1)
  expect(h.store.stats.legacyImports).toBe(0)
  expect(h.ready()!.generation).toBe(1)
  expect((await (await h.disk.open(h.ready()!)).read('unit:0'))).toEqual({ text: 'legacy' })
})

it('falls back when the legacy manifest is damaged or the document schema is wrong', async () => {
  const corrupt = await setup()
  await writeFile(join(corrupt.legacyDir(), 'manifest.json'), '{corrupt')
  corrupt.mockSourceBuild()
  await corrupt.open()
  expect(corrupt.store.stats.legacyImports).toBe(0)
  expect(corrupt.ready()!.generation).toBe(1)

  const wrongSchema = await setup()
  const store = new ArtifactStore(wrongSchema.root)
  const key = artifactKey(wrongSchema.identity)
  await store.evict(key)
  await store.getOrBuild(wrongSchema.identity, async (writer) => {
    await writer.append('document', { model: { format: 'docx', unitCount: 1 }, fonts: [] })
    await writer.append('unit:0', { text: 'legacy' })
    await writer.append('external-media', [])
  })
  wrongSchema.mockSourceBuild()
  await wrongSchema.open()
  expect(wrongSchema.store.stats.legacyImports).toBe(0)
  expect(wrongSchema.ready()!.generation).toBe(1)
})

it('does not mistake generation-only directories for a legacy flat artifact', async () => {
  const h = await setup({ withLegacy: false })
  const parse = h.mockSourceBuild()
  await h.open()
  expect(parse).toHaveBeenCalledTimes(1)
  expect(h.store.stats.legacyImports).toBe(0)
  // A second view must attach to the ready generation, not import it again.
  await h.open()
  expect(parse).toHaveBeenCalledTimes(1)
  expect(h.catalog.complete).toHaveBeenCalledTimes(1)
})

it('a version-mismatched legacy artifact is never imported', async () => {
  const h = await setup()
  const key = artifactKey(h.identity)
  const directory = h.legacyDir()
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>
  // Rewriting the identity breaks artifactKey(identity) === key, so the reader
  // refuses the index; the migration must treat that as untrusted, not as a cache hit.
  manifest.identity = { ...(manifest.identity as object), options: { changed: true } }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(h.store.find(key)).rejects.toBeInstanceOf(ArtifactCorruptionError)
  const parse = h.mockSourceBuild()
  await h.open()
  expect(parse).toHaveBeenCalledTimes(1)
  expect(h.store.stats.legacyImports).toBe(0)
})
