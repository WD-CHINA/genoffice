import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactStore } from '../src/artifact-store'
import { validateRuntimeOptions } from '../src/runtime-options'
import { createParseServer } from '../src/server'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('bounds every shutdown phase so stuck IO cannot hang the process', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'shutdown-timeout-'))
  dirs.push(dataDir)
  const server = await createParseServer({ dataDir, shutdownTimeoutMs: 150 })
  // Simulate an unresponsive artifact drain (disk/IO stuck).
  vi.spyOn(ArtifactStore.prototype, 'drain').mockImplementation(() => new Promise<void>(() => undefined))
  const started = Date.now()
  await server.close()
  expect(Date.now() - started).toBeLessThan(3_000)
})

it('rejects invalid shutdown budgets before startup', () => {
  for (const value of [0, -1, 600_001, 1.5]) {
    expect(() => validateRuntimeOptions({
      dataDir: '/unused', shutdownTimeoutMs: value,
    })).toThrow(/shutdownTimeoutMs/)
  }
})
