import { expect, it } from 'vitest'
import { layoutCacheKey, measurementProfileHash } from '../src/layout-key'

const artifactKey = 'a'.repeat(64)
it('keys layouts by artifact, width, font set, renderer and measurement profile', () => {
  const base = layoutCacheKey({ artifactKey, width: 960, fontSetHash: 'fonts-v1' })
  expect(base).toMatch(/^[a-f0-9]{64}$/)
  expect(layoutCacheKey({ artifactKey, width: 960, fontSetHash: 'fonts-v1' })).toBe(base)
  expect(layoutCacheKey({ artifactKey, width: 1280, fontSetHash: 'fonts-v1' })).not.toBe(base)
  expect(layoutCacheKey({ artifactKey, width: 960, fontSetHash: 'fonts-v2' })).not.toBe(base)
  expect(
    layoutCacheKey({ artifactKey, width: 960, fontSetHash: 'fonts-v1', rendererVersion: 2 }),
  ).not.toBe(base)
  expect(measurementProfileHash()).toMatch(/^[a-f0-9]{64}$/)
  for (const invalid of [
    { artifactKey: 'bad', width: 960, fontSetHash: 'x' },
    { artifactKey, width: 0, fontSetHash: 'x' },
    { artifactKey, width: 960, fontSetHash: '' },
    { artifactKey, width: 960, fontSetHash: 'x', rendererVersion: 0 },
    { artifactKey, width: 960, fontSetHash: 'x', measurementProfile: 'bad' },
  ]) {
    expect(() => layoutCacheKey(invalid as never)).toThrow(/invalid/)
  }
})

import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createParseServer, type ParseServer } from '../src/server'

it('exposes an opaque layoutKey on v1 ready views and varies by width', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'layout-key-'))
  let server: ParseServer | undefined
  try {
    server = await createParseServer({ dataDir })
    const request = (path: string, init?: RequestInit) => fetch(server!.url + path, init)
    const uploaded = await request('/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const open = async (width: number) => {
      const response = await request('/v1/sessions', {
        method: 'POST',
        headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
        body: JSON.stringify({ fileId, width }),
      })
      return (await response.json()) as { sessionId: string }
    }
    const waitReady = async (sessionId: string) => {
      const deadline = Date.now() + 20_000
      for (;;) {
        const body = (await (await request(`/v1/sessions/${sessionId}`)).json()) as {
          state: string
          layoutKey?: string
        }
        if (body.state === 'ready') return body
        if (body.state === 'failed') throw new Error('session failed')
        if (Date.now() > deadline) throw new Error('session did not become ready')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
    const narrow = await open(640)
    const wide = await open(1280)
    const narrowReady = await waitReady(narrow.sessionId)
    const wideReady = await waitReady(wide.sessionId)
    expect(narrowReady.layoutKey).toMatch(/^[a-f0-9]{64}$/)
    expect(wideReady.layoutKey).toMatch(/^[a-f0-9]{64}$/)
    expect(wideReady.layoutKey).not.toBe(narrowReady.layoutKey)
    const document = (await (
      await request(`/v1/sessions/${narrow.sessionId}/document`)
    ).json()) as {
      layoutKey?: string
    }
    expect(document.layoutKey).toBe(narrowReady.layoutKey)
    // v1 keeps its body.
    const v1 = (await (
      await request('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, width: 640 }),
      })
    ).json()) as { layoutKey?: string }
    expect(v1.layoutKey).toBeUndefined()
  } finally {
    await server?.close().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true })
  }
})
