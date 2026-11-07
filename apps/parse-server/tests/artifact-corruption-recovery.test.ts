import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactSession, type ArtifactSessionInput } from '../src/artifact-session'
import { ArtifactStore, ArtifactCorruptionError, artifactKey, type ArtifactWriter } from '../src/artifact-store'
import { ArtifactGenerations } from '../src/artifact-generations'
import { ArtifactCoordinator } from '../src/artifact-coordinator'
import { ArtifactReadHandle } from '../src/artifact-read-handle'
import type { MysqlArtifactCatalog, ReadyArtifact, ArtifactClaim } from '../src/artifact-catalog'
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
  ready(): ReadyArtifact | undefined
  builds(): number
  open(): Promise<ArtifactSession>
}

async function setup(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'artifact-corruption-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const input: ArtifactSessionInput = {
    id: randomUUID(), fileId: 'a'.repeat(64), path: join(root, 'source.pptx'), width: 960,
    parserVersion: 'test', parserFingerprint: 'corruption-recovery', baseUrl: 'http://localhost',
    format: 'pptx', chunkRoot: join(root, 'chunks'), limits: DEFAULT_LIMITS,
    parseTimeoutMs: 10_000, unitTimeoutMs: 10_000, workerMemoryMb: 128, workerRssMb: 512,
    processGroup: randomUUID(),
  }
  const key = artifactKey(ArtifactSession.identity(input))
  let ready: ReadyArtifact | undefined
  let generation = 0
  let builds = 0
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
  const store = new ArtifactStore(root)
  const disk = new ArtifactGenerations(root)
  const coordinator = new ArtifactCoordinator(catalog, disk, 5, 2000)
  cleanup.push(() => coordinator.close())
  const sessions: ArtifactSession[] = []
  cleanup.push(async () => { for (const session of sessions.splice(0)) await session.dispose() })

  // Replace the real parser with deterministic persisted records, so these tests
  // exercise corruption reporting/recovery rather than PPTX parsing.
  vi.spyOn(ArtifactSession, 'build').mockImplementation(
    async (_store: ArtifactStore, _input: ArtifactSessionInput, writer: ArtifactWriter) => {
      builds++
      await writer.append('document', {
        model: { format: 'pptx', unitCount: 1, generation: builds }, fonts: [],
      })
      await writer.append('unit:0', { text: `generation-${builds}` })
      await writer.append('external-media', [])
    },
  )

  const backend = {
    catalog: catalog as unknown as MysqlArtifactCatalog,
    disk,
    coordinator,
  }
  return {
    root, input, store, disk, catalog, backend, sessions,
    ready: () => ready,
    builds: () => builds,
    open: async () => {
      const session = await ArtifactSession.openShared(store, input, backend)
      sessions.push(session)
      return session
    },
  }
}

/** The persisted unit is a plain JSON record, not a real PptxLayoutSlide. */
function unitText(value: unknown): string {
  return (value as unknown as { text: string }).text
}

/** Corrupt exactly one persisted frame without touching the manifest or other records. */
async function damage(root: string, ready: ReadyArtifact, id: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, ready.storagePath, 'manifest.json'), 'utf8')) as {
    records: Array<{ id: string; offset: number; length: number }>
  }
  const entry = manifest.records.find((record) => record.id === id)
  if (!entry) throw new Error(`missing record ${id}`)
  const position = entry.offset + Math.floor(entry.length / 2)
  const handle = await open(join(root, ready.storagePath, 'units.bin'), 'r+')
  try {
    const byte = Buffer.alloc(1)
    await handle.read(byte, 0, 1, position)
    byte[0] ^= 0xff
    await handle.write(byte, 0, 1, position)
  } finally { await handle.close() }
}

it('reports one lazy frame corruption exactly once against the exact generation pointer', async () => {
  const h = await setup()
  const session = await h.open()
  const first = h.ready()!
  const onCorruption = vi.fn()
  const reader = await h.disk.open(first, onCorruption)
  await damage(h.root, first, 'unit:0')
  const results = await Promise.allSettled([reader.read('unit:0'), reader.read('unit:0')])
  expect(results.every((result) => result.status === 'rejected')).toBe(true)
  expect((results[0] as PromiseRejectedResult).reason).toBeInstanceOf(ArtifactCorruptionError)
  expect(onCorruption).toHaveBeenCalledTimes(1)
  expect((session.model as { generation?: number }).generation).toBe(1)
})

it('rebuilds a damaged unit once and retries in an already-open view', async () => {
  const h = await setup()
  const session = await h.open()
  const first = h.ready()!
  expect(unitText(await session.layoutModel('0'))).toBe('generation-1')
  await damage(h.root, first, 'unit:0')

  expect(unitText(await session.layoutModel('0'))).toBe('generation-2')
  expect(h.builds()).toBe(2)
  expect(h.ready()!.generation).toBe(2)
  expect((session.model as { generation?: number }).generation).toBe(2)
  expect(h.catalog.invalidateReady).toHaveBeenCalledWith(first)
  // The old immutable generation is never deleted by the repair path.
  await expect(stat(join(h.root, first.storagePath, 'manifest.json'))).resolves.toBeDefined()
  // A second unrelated damage must not loop into another rebuild.
  await damage(h.root, h.ready()!, 'unit:0')
  await expect(session.layoutModel('0')).rejects.toBeInstanceOf(ArtifactCorruptionError)
  expect(h.builds()).toBe(2)
  await session.dispose()
  expect(h.catalog.releaseRead).toHaveBeenCalledTimes(2)
})

it('deduplicates concurrent repairs across views into one shared rebuild', async () => {
  const h = await setup()
  const firstSession = await h.open()
  const secondSession = await h.open()
  expect(h.builds()).toBe(1)
  const first = h.ready()!
  await damage(h.root, first, 'unit:0')

  const results = await Promise.all([
    firstSession.layoutModel('0'),
    secondSession.layoutModel('0'),
  ])
  expect(results.map(unitText))
    .toEqual(['generation-2', 'generation-2'])
  expect(h.builds()).toBe(2)
  expect(h.ready()!.generation).toBe(2)
  expect(h.catalog.complete).toHaveBeenCalledTimes(2)
})

it('does not withdraw readiness for an ordinary filesystem error', async () => {
  const h = await setup()
  const session = await h.open()
  const handle = (await ArtifactReadHandle.open(
    h.backend.catalog, h.disk, h.ready()!.key, 'probe',
  ))!
  const reader = (handle as unknown as { reader: { read: (id: string) => Promise<unknown> } }).reader
  const ioError = Object.assign(new Error('permission denied'), { code: 'EACCES' })
  reader.read = vi.fn(async () => { throw ioError })
  await expect(handle.read('unit:0')).rejects.toMatchObject({ code: 'EACCES' })
  expect(h.catalog.invalidateReady).not.toHaveBeenCalled()
  await handle.close()
  await session.dispose()
})

it('a closed view never rebuilds a damaged generation', async () => {
  const h = await setup()
  const session = await h.open()
  await damage(h.root, h.ready()!, 'unit:0')
  await session.dispose()
  await expect(session.layoutModel('0')).rejects.toThrow('document session is closed')
  expect(h.builds()).toBe(1)
})

it('a damaged document record is detected at admission and repaired before the view opens', async () => {
  const h = await setup()
  const first = (await (async () => {
    const session = await h.open()
    const ready = h.ready()!
    await session.dispose()
    return ready
  })())
  await damage(h.root, first, 'document')
  const session = await h.open()
  expect(unitText(await session.layoutModel('0'))).toBe('generation-2')
  expect(h.builds()).toBe(2)
  expect(h.ready()!.generation).toBe(2)
})
