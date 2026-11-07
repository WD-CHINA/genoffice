import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactGenerationSweeper } from '../src/artifact-generation-sweeper'
import { ArtifactGenerations } from '../src/artifact-generations'
import { artifactKey, type ArtifactIdentity } from '../src/artifact-store'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const identity: ArtifactIdentity = { fileId: 'a'.repeat(64), format: 'pptx', parserFingerprint: 'sweep-test', schemaVersion: 2, options: {} }
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'generation-sweep-'))
  roots.push(root)
  const disk = new ArtifactGenerations(root)
  const publish = async (generation: number) => {
    const artifact = await disk.publish(identity, generation, async (writer) => {
      await writer.append('unit:0', { generation })
    })
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    await utimes(join(root, artifact.storagePath), old, old)
    return artifact
  }
  return { root, disk, publish }
}

it('bounded passes advance beyond protected entries and revisit late orphan publications', async () => {
  const { disk, publish } = await setup()
  const first = await publish(1)
  const second = await publish(2)
  const retireGeneration = vi.fn(async (_key: string, generation: number) => generation !== 1)
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 1, collected: 0, hasMore: true })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 0, collected: 1, hasMore: true })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 0, hasMore: false })
  expect(await (await disk.open(first)).read('unit:0')).toEqual({ generation: 1 })
  await expect(disk.open(second)).rejects.toThrow('generation missing')
  await publish(2) // Simulate a stale writer publishing after the first sweep.
  expect(await sweeper.sweep()).toMatchObject({ examined: 2, collected: 1, protected: 1, hasMore: false })
  await expect(disk.open(second)).rejects.toThrow('generation missing')
})

it('grace periods, canonical names and symlink boundaries protect unrelated data', async () => {
  const { root, disk, publish } = await setup()
  const young = await publish(1)
  const future = new Date(Date.now() + 60 * 60_000)
  await utimes(join(root, young.storagePath), future, future)
  await publish(2)
  const parent = join(root, 'artifacts', young.key.slice(0, 2), young.key)
  for (const name of ['g-01', 'g-0', 'g-9007199254740992', 'unknown']) {
    await mkdir(join(parent, name))
    await writeFile(join(parent, name, 'keep'), 'unmanaged')
  }
  if (process.platform !== 'win32') {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'unrelated')
    await symlink(outside, join(parent, 'g-3'))
  }
  const retireGeneration = vi.fn(async () => false)
  const result = await new ArtifactGenerationSweeper(disk, { retireGeneration }).sweep()
  expect(result).toMatchObject({ examined: 2, young: 1, protected: 1, failed: 0 })
  expect(retireGeneration).toHaveBeenCalledTimes(1)
  expect(retireGeneration).toHaveBeenCalledWith(young.key, 2)
  expect(await readdir(join(parent, 'g-01'))).toEqual(['keep'])
})

it('failed candidates remain observable and retry on the next pass without starving other entries', async () => {
  const { disk, publish } = await setup()
  await publish(1)
  await publish(2)
  const retireGeneration = vi.fn(async (_key: string, generation: number) => {
    if (generation === 1) throw Object.assign(new Error('sensitive SQL detail'), { code: 'ER_TEST_FAILURE' })
    return true
  })
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  const first = await sweeper.sweep()
  expect(first).toMatchObject({ failed: 1, collected: 1, hasMore: false })
  expect(first.errors).toEqual([{ key: artifactKey(identity), generation: 1, code: 'ER_TEST_FAILURE' }])
  expect(JSON.stringify(first)).not.toContain('sensitive')
  expect(await sweeper.sweep()).toMatchObject({ examined: 1, failed: 1 })
  expect(retireGeneration).toHaveBeenCalledTimes(3)
})

it('concurrent calls share one pass and invalid options do not start filesystem work', async () => {
  const { disk, publish } = await setup()
  await publish(1)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const retireGeneration = vi.fn(async () => { await gate; return false })
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  const first = sweeper.sweep()
  expect(sweeper.sweep()).toBe(first)
  try {
    for (const limit of [0, -1, NaN, 0.5, 4097]) expect(() => sweeper.sweep(limit)).toThrow('options')
    expect(() => sweeper.sweep(1, -1)).toThrow('options')
  } finally { release() }
  expect(await first).toMatchObject({ protected: 1 })
  expect(retireGeneration).toHaveBeenCalledTimes(1)
})

it('close drains the current collection but prevents any subsequent candidate or pass', async () => {
  const { disk, publish } = await setup()
  await publish(1)
  await publish(2)
  let release!: () => void
  let arrived!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { arrived = resolve })
  const retireGeneration = vi.fn(async () => { arrived(); await gate; return false })
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  const pass = sweeper.sweep()
  await started
  const closed = sweeper.close()
  expect(sweeper.close()).toBe(closed)
  let drained = false
  void closed.then(() => { drained = true })
  try {
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(() => sweeper.sweep()).toThrow('closed')
  } finally { release(); await closed }
  expect(await pass).toMatchObject({ examined: 1, protected: 1, stopped: true, hasMore: false })
  expect(retireGeneration).toHaveBeenCalledTimes(1)
})

it('closing before the scheduled pass starts performs no collection', async () => {
  const { disk, publish } = await setup()
  await publish(1)
  const retireGeneration = vi.fn(async () => false)
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  const pass = sweeper.sweep()
  await sweeper.close()
  expect(await pass).toMatchObject({ examined: 0, stopped: true })
  expect(retireGeneration).not.toHaveBeenCalled()
})

it('shared staging uses retirement fencing, bounded continuation and conservative name validation', async () => {
  const { root, disk } = await setup()
  const key = artifactKey(identity)
  const staging = join(root, 'staging')
  await mkdir(staging)
  const names = [1, 2, 3].map((generation) => `gen-${key}-g-${generation}-${randomUUID()}`)
  const old = new Date(Date.now() - 2 * 60 * 60_000)
  for (const name of [...names, `gen-${key}-g-01-${randomUUID()}`, 'unknown']) {
    await mkdir(join(staging, name))
    await writeFile(join(staging, name, 'units.bin'), 'keep until authorized')
    await utimes(join(staging, name), old, old)
  }
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'unrelated')
  if (process.platform !== 'win32') await symlink(outside, join(staging, `gen-${key}-g-4-${randomUUID()}`))
  const retireGeneration = vi.fn(async (_key: string, generation: number) => generation === 2)
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 1, hasMore: true })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, collected: 1, hasMore: true })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 1, protected: 1, hasMore: true })
  expect(await sweeper.sweep(1)).toMatchObject({ examined: 0, hasMore: false })
  expect(await readdir(staging)).toContain(names[0]) // Live build / ready pointer: SQL refuses retirement.
  expect(await readdir(staging)).not.toContain(names[1])
  expect(await readdir(staging)).toContain(names[2])
  expect(await readdir(outside)).toEqual(['keep'])
  expect(retireGeneration.mock.calls.map((call) => call[1])).toEqual([1, 2, 3])
  expect(await sweeper.sweep()).toMatchObject({ examined: 2, protected: 2 })
})

it('staging cleanup preserves young directories and fails closed on catalog errors', async () => {
  const { root, disk } = await setup()
  const key = artifactKey(identity)
  const staging = join(root, 'staging')
  const name = `gen-${key}-g-1-${randomUUID()}`
  await mkdir(join(staging, name), { recursive: true })
  const retireGeneration = vi.fn(async () => { throw new Error('private database detail') })
  const sweeper = new ArtifactGenerationSweeper(disk, { retireGeneration })
  expect(await sweeper.sweep()).toMatchObject({ young: 1, failed: 0 })
  expect(retireGeneration).not.toHaveBeenCalled()
  const old = new Date(Date.now() - 60_000)
  await utimes(join(staging, name), old, old)
  const result = await sweeper.sweep(64, 0)
  expect(result).toMatchObject({ failed: 1, collected: 0 })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(await readdir(staging)).toEqual([name])
})
