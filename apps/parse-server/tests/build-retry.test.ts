import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ArtifactStore, type ArtifactIdentity } from '../src/artifact-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(maxRetries = 2) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-retry-'))
  directories.push(root)
  // positional: root, maxRecordBytes, budget, cache, pools, maxBuildRetries, baseDelayMs
  const store = new ArtifactStore(root, undefined, undefined, undefined, undefined, maxRetries, 1)
  return { root, store }
}

const identity: ArtifactIdentity = {
  fileId: 'b'.repeat(64), format: 'pptx', parserFingerprint: 'retry-test', schemaVersion: 2, options: {},
}

it('retries a transient local build failure and cleans the abandoned staging directory', async () => {
  const { root, store } = await setup()
  let builds = 0
  const reader = await store.getOrBuild(identity, async (writer) => {
    builds++
    if (builds === 1) throw Object.assign(new Error('resource temporarily unavailable'), { code: 'EAGAIN' })
    await writer.append('unit:0', { text: 'after-retry' })
  })
  expect(builds).toBe(2)
  expect(store.stats.buildsStarted).toBe(2)
  expect(store.stats.buildRetries).toBe(1)
  expect(await reader.read('unit:0')).toEqual({ text: 'after-retry' })
  expect(await readdir(join(root, 'staging'))).toEqual([])
})

it('does not retry a malformed-source build error', async () => {
  const { store } = await setup()
  let builds = 0
  await expect(store.getOrBuild(identity, async () => {
    builds++
    throw new Error('invalid pptx archive')
  })).rejects.toThrow('invalid pptx archive')
  expect(builds).toBe(1)
})

it('stops after the configured local retry budget', async () => {
  const { store } = await setup(1)
  let builds = 0
  await expect(store.getOrBuild(identity, async () => {
    builds++
    throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
  })).rejects.toThrow('deadlock')
  expect(builds).toBe(2)
})
