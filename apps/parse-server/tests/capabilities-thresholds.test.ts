import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validateRuntimeOptions } from '../src/runtime-options'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('advertises deployment routing thresholds and rejects invalid values', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cap-thresholds-'))
  dirs.push(dataDir)
  const server = await createParseServer({
    dataDir,
    docxAutoRemoteBytes: 3 * 1024 * 1024,
    pptxAutoRemoteBytes: 5 * 1024 * 1024,
    docxFullRenderBytes: 7 * 1024 * 1024,
  })
  servers.push(server)
  const capabilities = await (await fetch(server.url + '/v2/capabilities')).json() as {
    thresholds: { docxAutoRemoteBytes: number; pptxAutoRemoteBytes: number; docxFullRenderBytes: number }
  }
  expect(capabilities.thresholds).toEqual({
    docxAutoRemoteBytes: 3 * 1024 * 1024,
    pptxAutoRemoteBytes: 5 * 1024 * 1024,
    docxFullRenderBytes: 7 * 1024 * 1024,
  })
  // Defaults remain 32/64/64 MiB.
  const defaultsDir = await mkdtemp(join(tmpdir(), 'cap-thresholds-'))
  dirs.push(defaultsDir)
  const defaults = await createParseServer({ dataDir: defaultsDir })
  servers.push(defaults)
  const defaultCaps = await (await fetch(defaults.url + '/v2/capabilities')).json() as {
    thresholds: { docxAutoRemoteBytes: number; pptxAutoRemoteBytes: number; docxFullRenderBytes: number }
  }
  expect(defaultCaps.thresholds).toEqual({
    docxAutoRemoteBytes: 32 * 1024 * 1024,
    pptxAutoRemoteBytes: 64 * 1024 * 1024,
    docxFullRenderBytes: 64 * 1024 * 1024,
  })
  for (const value of [0, -1, 1.5, Number.NaN]) {
    expect(() => validateRuntimeOptions({
      dataDir: '/unused', docxAutoRemoteBytes: value,
    })).toThrow(/docxAutoRemoteBytes/)
  }
})
