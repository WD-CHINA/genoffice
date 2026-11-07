import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, open, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactGenerationSweeper } from '../src/artifact-generation-sweeper'
import { ArtifactGenerations } from '../src/artifact-generations'
import type { ReadyArtifact } from '../src/artifact-catalog'
import {
  ArtifactStore, ArtifactWriter, artifactKey, type ArtifactIdentity,
} from '../src/artifact-store'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const base: ArtifactIdentity = {
  fileId: 'a'.repeat(64), format: 'pptx', parserFingerprint: 'flat-collection-test',
  schemaVersion: 2, options: {},
}
const secondIdentity: ArtifactIdentity = { ...base, parserFingerprint: 'flat-collection-second' }

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'legacy-flat-'))
  roots.push(root)
  return { root, disk: new ArtifactGenerations(root) }
}

/** Publish a real pre-generation flat layout, then a SQL-ready generation beside it. */
async function addLegacyFlat(root: string, disk: ArtifactGenerations, identity: ArtifactIdentity) {
  const key = artifactKey(identity)
  const directory = join(root, 'artifacts', key.slice(0, 2), key)
  const flatStaging = join(root, 'staging', randomUUID())
  await mkdir(flatStaging, { recursive: true })
  const writer = new ArtifactWriter(
    await open(join(flatStaging, 'units.bin'), 'wx'), flatStaging, directory, identity,
    64 * 1024 * 1024,
  )
  await writer.append('unit:0', { legacy: true })
  await writer.publish()
  const flatBytes =
    (await stat(join(directory, 'manifest.json')).then((info) => info.size)) +
    (await stat(join(directory, 'units.bin')).then((info) => info.size))
  const ready = await disk.publish(identity, 1, async (target) => {
    await target.append('unit:0', { generation: 1 })
  })
  return { key, directory, flatBytes, ready }
}

async function setup(identity: ArtifactIdentity = base, shared?: { root: string; disk: ArtifactGenerations }) {
  const { root, disk } = shared ?? await createRoot()
  const flat = await addLegacyFlat(root, disk, identity)
  const catalog = {
    retireGeneration: vi.fn(async () => false),
    authorizeFlatArchive: vi.fn(async () => flat.ready as ReadyArtifact | null),
  }
  return { root, disk, store: new ArtifactStore(root), ...flat, catalog }
}

function flatCatalog(ready: ReadyArtifact | null) {
  return { authorizeFlatArchive: vi.fn(async () => ready) }
}

function ageFlat(directory: string) {
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  return Promise.all(['manifest.json', 'units.bin', 'g-1'].map((name) =>
    utimes(join(directory, name), old, old)))
}

it('removes only the legacy flat files and keeps the ready generation readable', async () => {
  const { disk, store, key, directory, flatBytes, ready, catalog } = await setup()
  const before = await store.totalBytes()
  expect((await store.legacyFlatEntries()).bytes).toBe(flatBytes)
  const freed = await disk.collectLegacyFlat(key, catalog)
  expect(freed).toBe(flatBytes)
  expect(catalog.authorizeFlatArchive).toHaveBeenCalledWith(key)
  const children = await readdir(directory)
  expect(children).toContain('g-1')
  expect(children).not.toContain('manifest.json')
  expect(children).not.toContain('units.bin')
  expect(await (await disk.open(ready)).read('unit:0')).toEqual({ generation: 1 })
  expect(await store.totalBytes()).toBe(before - freed)
  expect((await store.legacyFlatEntries()).bytes).toBe(0)
})

it('a catalog veto leaves both legacy files untouched', async () => {
  const { disk, key, directory, catalog } = await setup()
  catalog.authorizeFlatArchive.mockResolvedValueOnce(null)
  expect(await disk.collectLegacyFlat(key, catalog)).toBe(0)
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'units.bin', 'g-1']))
})

it('fails closed when the replacement generation is missing', async () => {
  const { root, disk, key, directory, catalog, ready } = await setup()
  await rm(join(root, ready.storagePath), { recursive: true, force: true })
  await expect(disk.collectLegacyFlat(key, catalog)).rejects.toThrow()
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'units.bin']))
})

it('fails closed when the generation manifest no longer matches the registered digest', async () => {
  const { disk, key, directory, catalog, ready } = await setup()
  catalog.authorizeFlatArchive.mockResolvedValueOnce({ ...ready, manifestSha256: 'f'.repeat(64) })
  await expect(disk.collectLegacyFlat(key, catalog)).rejects.toThrow('checksum mismatch')
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'units.bin']))
})

it('rejects non-regular flat paths before unlinking anything', async () => {
  const { disk, key, directory, catalog } = await setup()
  await rm(join(directory, 'units.bin'))
  await mkdir(join(directory, 'units.bin'))
  await expect(disk.collectLegacyFlat(key, catalog)).rejects.toThrow('not a regular file')
  expect(await stat(join(directory, 'manifest.json'))).toBeTruthy()
  expect(await readdir(join(directory, 'units.bin'))).toEqual([])
})

it('does not follow symlinked flat paths', async () => {
  if (process.platform === 'win32') return
  const { root, disk, key, directory, catalog } = await setup()
  await rm(join(directory, 'units.bin'))
  const outside = join(root, 'outside')
  await writeFile(outside, 'unrelated')
  await symlink(outside, join(directory, 'units.bin'))
  await expect(disk.collectLegacyFlat(key, catalog)).rejects.toThrow('not a regular file')
  expect(await lstat(join(directory, 'manifest.json'))).toBeTruthy()
  expect(await readdir(directory)).toContain('units.bin')
  expect(await stat(outside)).toBeTruthy()
})

it('repeated collection is idempotent and never double-counts bytes', async () => {
  const { disk, key, flatBytes, catalog } = await setup()
  expect(await disk.collectLegacyFlat(key, catalog)).toBe(flatBytes)
  expect(await disk.collectLegacyFlat(key, catalog)).toBe(0)
  expect(catalog.authorizeFlatArchive).toHaveBeenCalledTimes(2)
})

it('the sweeper archives aged flat files after its generation/staging phases', async () => {
  const { disk, key, directory, flatBytes, ready } = await setup()
  await ageFlat(directory)
  const onFlatCollected = vi.fn()
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration: vi.fn(async () => false) },
    flatCatalog(ready), onFlatCollected)
  const result = await sweeper.sweep()
  expect(result).toMatchObject({ examined: 2, protected: 1, collected: 1,
    flatCollected: 1, flatBytes, hasMore: false })
  expect(onFlatCollected).toHaveBeenCalledWith(key, flatBytes)
  expect(await readdir(directory)).toEqual(['g-1'])
  expect(await (await disk.open(ready)).read('unit:0')).toEqual({ generation: 1 })
})

it('young flat files stay protected, and a missing catalog never authorizes deletion', async () => {
  const { disk, directory, ready } = await setup()
  const young = await new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }, flatCatalog(ready)).sweep()
  expect(young).toMatchObject({ young: 2, flatCollected: 0 })
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'units.bin']))

  await ageFlat(directory)
  const withoutCatalog = await new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }).sweep()
  expect(withoutCatalog).toMatchObject({ protected: 2, flatCollected: 0 })
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'units.bin']))
})

it('catalog failures are observable without leaking SQL detail and retry on the next pass', async () => {
  const { disk, key, directory, ready } = await setup()
  await ageFlat(directory)
  let fail = true
  const authorizeFlatArchive = vi.fn(async () => {
    if (fail) throw Object.assign(new Error('private database detail'), { code: 'ER_TEST_FAILURE' })
    return ready
  })
  const sweeper = new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }, { authorizeFlatArchive })
  const failed = await sweeper.sweep()
  expect(failed).toMatchObject({ failed: 1, collected: 0, flatCollected: 0 })
  expect(failed.errors).toEqual([{ key, generation: 0, code: 'ER_TEST_FAILURE' }])
  expect(JSON.stringify(failed)).not.toContain('private database')
  expect(await readdir(directory)).toEqual(expect.arrayContaining(['manifest.json', 'units.bin']))

  fail = false
  expect(await sweeper.sweep()).toMatchObject({ flatCollected: 1, failed: 0 })
  expect(await readdir(directory)).toEqual(['g-1'])
})

it('bounded passes resume across flat candidates of multiple keys', async () => {
  const shared = await createRoot()
  const first = await setup(base, shared)
  const second = await setup(secondIdentity, shared)
  await ageFlat(first.directory)
  await ageFlat(second.directory)
  const catalog = {
    retireGeneration: vi.fn(async () => false),
    authorizeFlatArchive: vi.fn(async (key: string) => key === first.key ? first.ready : second.ready),
  }
  const sweeper = new ArtifactGenerationSweeper(shared.disk, catalog, catalog)
  let flatCollected = 0
  for (let i = 0; i < 8; i++) {
    const result = await sweeper.sweep(1, 0)
    flatCollected += result.flatCollected
    if (!result.hasMore) break
  }
  expect(flatCollected).toBe(2)
  expect(await readdir(first.directory)).toEqual(['g-1'])
  expect(await readdir(second.directory)).toEqual(['g-1'])
})
