import { expect, it } from 'vitest'
import { normalizeLayoutPrefs } from '../src/layout-prefs'

it('normalizes bounded reading preferences and rejects arbitrary JSON', () => {
  expect(normalizeLayoutPrefs(undefined)).toBeUndefined()
  expect(normalizeLayoutPrefs({})).toBeUndefined()
  expect(normalizeLayoutPrefs({ zoom: 1.5, page: 3 })).toEqual({ zoom: 1.5, page: 3 })
  expect(
    normalizeLayoutPrefs({
      zoom: 0.25,
      anchor: { unitId: '12', blockIndex: 3, offsetPx: -42.5 },
    }),
  ).toEqual({ zoom: 0.25, anchor: { unitId: '12', blockIndex: 3, offsetPx: -42.5 } })
  for (const invalid of [
    null,
    [],
    'x',
    { extra: 1 },
    { zoom: 0.1 },
    { zoom: 5 },
    { zoom: Number.NaN },
    { page: -1 },
    { page: 1.5 },
    { anchor: {} },
    { anchor: { unitId: '' } },
    { anchor: { unitId: 'a'.repeat(65) } },
    { anchor: { unitId: 'x', extra: 1 } },
    { anchor: { unitId: 'x', blockIndex: -1 } },
    { anchor: { unitId: 'x', offsetPx: 1e7 } },
    { anchor: { unitId: 'bad\nunit' } },
  ]) {
    expect(() => normalizeLayoutPrefs(invalid), JSON.stringify(invalid)).toThrow(
      /invalid layout preference/,
    )
  }
})

import { createBlankPptx } from '@genoffice/pptx-engine'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createParseServer, type ParseServer } from '../src/server'

it('carries layout preferences through the async waiter into the ready view', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'layout-prefs-'))
  let server: ParseServer | undefined
  try {
    server = await createParseServer({
      dataDir,
      parserVersion: '0.1.0',
      parserFingerprint: 'layout-prefs-test',
    })
    const uploaded = await fetch(server.url + '/v1/files', {
      method: 'POST',
      body: Buffer.from(await createBlankPptx()),
    })
    const { fileId } = (await uploaded.json()) as { fileId: string }
    const request = (path: string, init?: RequestInit) => fetch(server!.url + path, init)
    const prefs = { zoom: 1.5, page: 2, anchor: { unitId: '0', blockIndex: 1, offsetPx: 12.5 } }
    const opened = await request('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId, layoutPrefs: prefs }),
    })
    expect([201, 202]).toContain(opened.status)
    const created = (await opened.json()) as { sessionId: string; layoutPrefs?: unknown }
    expect(created.layoutPrefs).toEqual(prefs)
    const deadline = Date.now() + 20_000
    let ready: Record<string, unknown> = {}
    for (;;) {
      const status = await request(`/v1/sessions/${created.sessionId}`)
      ready = (await status.json()) as Record<string, unknown>
      if (ready.state === 'ready') break
      if (ready.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(ready.layoutPrefs).toEqual(prefs)
    // Heartbeat carries incremental page changes without recreating the session.
    const beat = await request(`/v1/sessions/${created.sessionId}/heartbeat`, {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ layoutPrefs: { page: 5 } }),
    })
    expect(beat.status).toBe(200)
    const moved = (await (await request(`/v1/sessions/${created.sessionId}`)).json()) as {
      layoutPrefs?: unknown
    }
    expect(moved.layoutPrefs).toEqual({ page: 5 })
    const invalidBeat = await request(`/v1/sessions/${created.sessionId}/heartbeat`, {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ layoutPrefs: { evil: true } }),
    })
    expect(invalidBeat.status).toBe(400)
    // Canonical reads retain the same preferences.
    const v1 = (await (await request(`/v1/sessions/${created.sessionId}`)).json()) as Record<
      string,
      unknown
    >
    expect(v1.layoutPrefs).toEqual({ page: 5 })

    const invalid = await request('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId, layoutPrefs: { evil: true } }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'invalid_request' })
  } finally {
    await server?.close().catch(() => undefined)
    await rm(dataDir, { recursive: true, force: true })
  }
})
