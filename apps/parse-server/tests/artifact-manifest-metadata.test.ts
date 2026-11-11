import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { OfflineBundleManifest } from '@genoffice/parse-contract'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('writes unit/font metadata and the bundle dependency into generation manifests', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'manifest-meta-'))
  dirs.push(dataDir)
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'manifest-meta-test',
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const uploaded = await request('/v1/files', {
    method: 'POST', body: Buffer.from(await createBlankPptx()),
  })
  const { fileId } = await uploaded.json() as { fileId: string }
  const opened = await request('/v2/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect([201, 202]).toContain(opened.status)
  const { sessionId } = await opened.json() as { sessionId: string }
  const deadline = Date.now() + 20_000
  let modelKey: string | undefined
  for (;;) {
    const body = await (await request(`/v2/sessions/${sessionId}`)).json() as {
      state: string; artifactKey?: string
    }
    if (body.state === 'ready') { modelKey = body.artifactKey ?? ''; break }
    if (body.state === 'failed') throw new Error('session failed')
    if (Date.now() > deadline) throw new Error('session did not become ready')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(modelKey).toMatch(/^[a-f0-9]{64}$/)
  if (!modelKey) throw new Error('missing artifactKey')
  const flat = (key: string) => join(dataDir, 'artifacts', key.slice(0, 2), key, 'manifest.json')
  const modelManifest = JSON.parse(await readFile(flat(modelKey), 'utf8')) as Record<string, unknown>
  expect(modelManifest.unitCount).toBe(1)
  expect(Array.isArray(modelManifest.fonts)).toBe(true)
  expect(Array.isArray(modelManifest.warnings)).toBe(true)
  expect(modelManifest.dependencies).toBeUndefined()

  const bundleResponse = await request(`/v2/sessions/${sessionId}/bundle`)
  expect(bundleResponse.status, await bundleResponse.clone().text()).toBe(200)
  const bundle = await bundleResponse.json() as OfflineBundleManifest
  const bundleManifest = JSON.parse(await readFile(flat(bundle.artifactKey), 'utf8')) as Record<string, unknown>
  expect(bundleManifest.dependencies).toEqual([modelKey])
})
