import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { reconcileOrphanGenerations } from '../src/generation-reconcile'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const key = (seed: string): string => seed.repeat(64).slice(0, 64)
async function generation(root: string, artifactKey: string, generationName: string, ageMs: number) {
  const path = join(root, 'artifacts', artifactKey.slice(0, 2), artifactKey, generationName)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'units.bin'), 'bytes')
  const stamp = new Date(Date.now() - ageMs)
  await utimes(path, stamp, stamp)
  return path
}

it('removes only aged generation dirs whose artifact key has no catalog row', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-'))
  dirs.push(root)
  const hour = 60 * 60_000
  const orphan = key('a')
  const building = key('b')
  const oldOrphan = await generation(root, orphan, 'g-1', 2 * hour)
  const youngOrphan = await generation(root, orphan, 'g-2', 5_000)
  const known = await generation(root, building, 'g-1', 2 * hour)
  // Unknown names and symlinks must be left alone.
  const unknown = join(root, 'artifacts', orphan.slice(0, 2), orphan, 'notes')
  await mkdir(unknown, { recursive: true })
  const link = join(root, 'artifacts', orphan.slice(0, 2), orphan, 'g-3')
  await symlink('/tmp', link).catch(() => undefined)

  const result = await reconcileOrphanGenerations({
    root,
    catalog: { hasArtifactRow: async (value) => value === building },
  })
  expect(result).toMatchObject({
    removedGenerations: 1,
    retainedGenerations: 2,
    inspectedKeys: 2,
    truncated: false,
    errors: [],
  })
  await expect(readdir(oldOrphan)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(youngOrphan)).resolves.toBeDefined()
  await expect(readdir(known)).resolves.toBeDefined()
  await expect(readdir(unknown)).resolves.toBeDefined()
})

it('removes an empty key bucket but never guesses when the catalog fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-'))
  dirs.push(root)
  const orphan = key('c')
  const known = key('d')
  await generation(root, orphan, 'g-1', 2 * 60 * 60_000)
  await generation(root, known, 'g-1', 2 * 60 * 60_000)
  const result = await reconcileOrphanGenerations({
    root,
    catalog: {
      hasArtifactRow: async (value) => {
        if (value === orphan) return false
        throw Object.assign(new Error('db down'), { code: 'ER_CON_COUNT_ERROR' })
      },
    },
  })
  expect(result.removedGenerations).toBe(1)
  expect(result.removedEmptyKeys).toBe(1)
  expect(result.retainedGenerations).toBe(1)
  expect(result.errors).toEqual(['ER_CON_COUNT_ERROR'])
  await expect(readdir(join(root, 'artifacts', orphan.slice(0, 2), orphan)))
    .rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readdir(join(root, 'artifacts', known.slice(0, 2), known, 'g-1')))
    .resolves.toBeDefined()
})

it('bounds startup work and rejects invalid configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reconcile-'))
  dirs.push(root)
  for (const seed of ['e', 'f']) await generation(root, key(seed), 'g-1', 2 * 60 * 60_000)
  const result = await reconcileOrphanGenerations({
    root,
    catalog: { hasArtifactRow: async () => false },
    maxKeys: 1,
  })
  expect(result.inspectedKeys).toBe(1)
  expect(result.truncated).toBe(true)
  await expect(reconcileOrphanGenerations({
    root, catalog: { hasArtifactRow: async () => false }, graceMs: -1,
  })).rejects.toThrow(/grace/)
  await expect(reconcileOrphanGenerations({
    root, catalog: { hasArtifactRow: async () => false }, maxKeys: 0,
  })).rejects.toThrow(/bound/)
  // Unknown bucket names are ignored entirely.
  await mkdir(join(root, 'artifacts', 'zz', key('g')), { recursive: true })
  const missing = await reconcileOrphanGenerations({
    root: join(root, 'missing-root'),
    catalog: { hasArtifactRow: async () => false },
  })
  expect(missing.removedGenerations).toBe(0)
  void randomUUID()
})
