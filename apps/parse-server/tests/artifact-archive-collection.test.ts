import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ArtifactArchive, MysqlArtifactCatalog } from '../src/artifact-catalog'
import { ArtifactGenerationSweeper } from '../src/artifact-generation-sweeper'
import { ArtifactGenerations } from '../src/artifact-generations'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const firstKey = 'a'.repeat(64)
const secondKey = 'b'.repeat(64)

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'artifact-archive-'))
  roots.push(root)
  return { root, disk: new ArtifactGenerations(root) }
}

function keyDirectory(root: string, key: string) {
  return join(root, 'artifacts', key.slice(0, 2), key)
}

async function addGeneration(root: string, key: string, generation: number, age = true) {
  const directory = join(keyDirectory(root, key), `g-${generation}`)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'manifest.json'), `generation ${generation}`)
  if (age) await agePath(directory)
  return directory
}

async function agePath(path: string) {
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  await utimes(path, old, old)
}

function archive(key: string, retiredGenerations = 3): ArtifactArchive {
  return { key, fileId: 'f'.repeat(64), generation: 6, retiredGenerations,
    flatArchived: true, archivedAt: Date.now() }
}

function archiveCatalog(summary: ArtifactArchive | null) {
  return { archiveArtifact: vi.fn(async (_key: string, _empty: boolean) => summary) }
}

interface Options {
  retain?: number
  archive?: Pick<MysqlArtifactCatalog, 'archiveArtifact'>
  onArchived?: (value: ArtifactArchive) => void
}
function sweeper(disk: ArtifactGenerations, retire: (key: string, generation: number) => boolean,
  options: Options = {}) {
  return new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async (key: string, generation: number) => retire(key, generation)) },
    undefined, undefined,
    { retainGenerations: options.retain ?? 4, archiveCatalog: options.archive,
      onArchived: options.onArchived })
}

it('archives an empty canonical key root only after SQL authorization', async () => {
  const { root, disk } = await createRoot()
  const directory = keyDirectory(root, firstKey)
  await mkdir(directory, { recursive: true })
  const catalog = archiveCatalog(archive(firstKey))
  expect(await disk.collectEmptyKey(firstKey, catalog)).toMatchObject({ key: firstKey, generation: 6 })
  expect(catalog.archiveArtifact).toHaveBeenCalledWith(firstKey, true)
  await expect(stat(directory)).rejects.toThrow()
  // The prefix bucket is removed too; the artifacts root itself stays.
  await expect(stat(join(root, 'artifacts', firstKey.slice(0, 2)))).rejects.toThrow()
  expect(await readdir(join(root, 'artifacts'))).toEqual([])
})

it('never archives a non-empty, non-canonical or symlinked key root', async () => {
  const { root, disk } = await createRoot()
  const catalog = archiveCatalog(archive(firstKey))
  const directory = keyDirectory(root, firstKey)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'unknown'), 'keep')
  expect(await disk.collectEmptyKey(firstKey, catalog)).toBeNull()
  expect(catalog.archiveArtifact).not.toHaveBeenCalled()
  expect(await readdir(directory)).toEqual(['unknown'])

  await rm(join(directory, 'unknown'))
  await mkdir(join(directory, 'g-7'))
  expect(await disk.collectEmptyKey(firstKey, catalog)).toBeNull()
  expect(await readdir(directory)).toEqual(['g-7'])

  await expect(disk.collectEmptyKey('not-a-key', catalog)).rejects.toThrow('invalid artifact key')
  expect(await disk.collectEmptyKey('c'.repeat(64), catalog)).toBeNull()
  if (process.platform !== 'win32') {
    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(join(root, 'artifacts', 'dd'), { recursive: true })
    await symlink(outside, keyDirectory(root, 'd'.repeat(64)))
    expect(await disk.collectEmptyKey('d'.repeat(64), catalog)).toBeNull()
    expect(await stat(outside)).toBeTruthy()
  }
  expect(catalog.archiveArtifact).not.toHaveBeenCalled()
})

it('a catalog veto keeps the empty directory and never reports an archive', async () => {
  const { root, disk } = await createRoot()
  const directory = keyDirectory(root, firstKey)
  await mkdir(directory, { recursive: true })
  await agePath(directory)
  const catalog = archiveCatalog(null)
  const cleared = new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }, undefined, undefined,
    { archiveCatalog: catalog }).sweep(64, 0)
  expect(await cleared).toMatchObject({ examined: 1, protected: 1, archivedKeys: 0 })
  expect(await readdir(directory)).toEqual([])
})

it('a concurrent publisher that repopulates the key wins the rmdir race', async () => {
  const { root, disk } = await createRoot()
  const directory = keyDirectory(root, firstKey)
  await mkdir(directory, { recursive: true })
  const summary = archive(firstKey, 0)
  const catalog = {
    archiveArtifact: vi.fn(async () => {
      await mkdir(join(directory, 'g-9'))
      return summary
    }),
  }
  expect(await disk.collectEmptyKey(firstKey, catalog)).toEqual(summary)
  expect(await readdir(directory)).toEqual(['g-9'])
  // The archived row is gone; a fresh publisher will re-create it via claim.
  expect(await disk.collectEmptyKey(firstKey, catalog)).toBeNull()
})

it('the retention high-water mark bypasses grace for the oldest generations only', async () => {
  const { root, disk } = await createRoot()
  for (let generation = 1; generation <= 6; generation++)
    await addGeneration(root, firstKey, generation, false) // all young
  const retireGeneration = vi.fn(async (_key: string, generation: number) =>
    generation !== 2 && generation !== 6)
  const instance = new ArtifactGenerationSweeper(disk, { retireGeneration },
    undefined, undefined, { retainGenerations: 2 })
  const result = await instance.sweep()
  expect(result).toMatchObject({ examined: 6, young: 2, collected: 3,
    protected: 1, highWaterArchived: 4, archivedKeys: 0, failed: 0 })
  // g-1..g-4 bypass the grace period, but g-2 is still fenced by SQL;
  // g-5/g-6 are inside the retention window and stay young.
  expect(retireGeneration).toHaveBeenCalledTimes(4)
  const children = await readdir(keyDirectory(root, firstKey))
  expect(children).toEqual(['g-2', 'g-5', 'g-6'])
})

it('storage pressure accelerates generations but never staging, flat or empty keys', async () => {
  const { root, disk } = await createRoot()
  await addGeneration(root, firstKey, 1, false)
  await addGeneration(root, firstKey, 2, false)
  const flat = keyDirectory(root, secondKey)
  await mkdir(flat, { recursive: true })
  await writeFile(join(flat, 'manifest.json'), 'legacy')
  await writeFile(join(flat, 'units.bin'), 'legacy')
  const empty = keyDirectory(root, 'c'.repeat(64))
  await mkdir(empty, { recursive: true })
  const staging = join(root, 'staging', `gen-${firstKey}-g-3-${randomUUID()}`)
  await mkdir(staging, { recursive: true })

  const retireGeneration = vi.fn(async (_key: string, generation: number) => generation === 1)
  const onArchived = vi.fn()
  const instance = new ArtifactGenerationSweeper(disk, { retireGeneration },
    undefined, undefined, { archiveCatalog: archiveCatalog(archive('c'.repeat(64))), onArchived })
  const normal = await instance.sweep(64, 60 * 60_000)
  expect(normal).toMatchObject({ young: 5, collected: 0, archivedKeys: 0, highWaterArchived: 0 })
  const urgent = await instance.sweep(64, 60 * 60_000, { urgent: true })
  expect(urgent).toMatchObject({ young: 3, collected: 1, protected: 1,
    archivedKeys: 0, failed: 0 })
  expect(retireGeneration).toHaveBeenCalledTimes(2) // g-1 and g-2
  expect(onArchived).not.toHaveBeenCalled()
  expect(await readdir(keyDirectory(root, firstKey))).toEqual(['g-2'])
  expect(await readdir(empty)).toEqual([])
  expect(await readdir(staging)).toEqual([])
})

it('the sweeper archives aged empty roots, reports retired rows and is idempotent', async () => {
  const { root, disk } = await createRoot()
  const directory = keyDirectory(root, firstKey)
  await mkdir(directory, { recursive: true })
  await agePath(directory)
  await agePath(join(root, 'artifacts', firstKey.slice(0, 2)))
  const onArchived = vi.fn()
  const instance = sweeper(disk, () => false,
    { archive: archiveCatalog(archive(firstKey, 5)), onArchived })
  expect(await instance.sweep()).toMatchObject({ examined: 1, collected: 1,
    archivedKeys: 1, retiredRows: 5, hasMore: false })
  expect(onArchived).toHaveBeenCalledTimes(1)
  await expect(stat(directory)).rejects.toThrow()
  expect(await instance.sweep()).toMatchObject({ examined: 0, archivedKeys: 0 })
  expect(onArchived).toHaveBeenCalledTimes(1)
})

it('SQL failures are observable, do not leak details and retry on the next pass', async () => {
  const { root, disk } = await createRoot()
  const directory = keyDirectory(root, firstKey)
  await mkdir(directory, { recursive: true })
  await agePath(directory)
  let fail = true
  const archiveArtifact = vi.fn(async () => {
    if (fail) throw Object.assign(new Error('private SQL detail'), { code: 'ER_TEST_FAILURE' })
    return archive(firstKey, 2)
  })
  const instance = new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }, undefined, undefined,
    { archiveCatalog: { archiveArtifact } })
  const failed = await instance.sweep()
  expect(failed).toMatchObject({ failed: 1, archivedKeys: 0 })
  expect(failed.errors).toEqual([{ key: firstKey, generation: 0, code: 'ER_TEST_FAILURE' }])
  expect(JSON.stringify(failed)).not.toContain('private SQL detail')
  expect(await readdir(directory)).toEqual([])
  fail = false
  expect(await instance.sweep()).toMatchObject({ archivedKeys: 1, retiredRows: 2, failed: 0 })
})

it('bounded passes resume across multiple empty keys', async () => {
  const { root, disk } = await createRoot()
  for (const key of [firstKey, secondKey]) {
    await mkdir(keyDirectory(root, key), { recursive: true })
    await agePath(keyDirectory(root, key))
  }
  const catalog = {
    archiveArtifact: vi.fn(async (key: string) => archive(key, 1)),
  }
  const instance = new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }, undefined, undefined,
    { archiveCatalog: catalog })
  let archived = 0
  for (let i = 0; i < 8; i++) {
    const result = await instance.sweep(1, 0)
    archived += result.archivedKeys
    if (!result.hasMore) break
  }
  expect(archived).toBe(2)
  expect(catalog.archiveArtifact).toHaveBeenCalledTimes(2)
})

it('closing mid-pass stops before the next candidate and reports stopped', async () => {
  const { root, disk } = await createRoot()
  for (const key of [firstKey, secondKey]) {
    await mkdir(keyDirectory(root, key), { recursive: true })
    await agePath(keyDirectory(root, key))
  }
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const catalog = { archiveArtifact: vi.fn(async (key: string) => {
    if (key === firstKey) await gate
    return archive(key, 1)
  }) }
  const instance = new ArtifactGenerationSweeper(disk,
    { retireGeneration: vi.fn(async () => false) }, undefined, undefined,
    { archiveCatalog: catalog })
  const work = instance.sweep(64, 0)
  await vi.waitFor(() => expect(catalog.archiveArtifact).toHaveBeenCalledTimes(1))
  const closing = instance.close()
  release()
  const result = await work
  await closing
  expect(result).toMatchObject({ stopped: true, archivedKeys: 1 })
  expect(catalog.archiveArtifact).toHaveBeenCalledTimes(1)
})
