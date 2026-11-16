import { createBlankPptx } from '@genoffice/pptx-engine'
import JSZip from 'jszip'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ArtifactSession } from '../src/artifact-session'
import { artifactKey } from '../src/artifact-store'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function markedPptx(marker: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  zip.file('async-contract-marker.txt', marker)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'async-contract-'))
  dirs.push(dataDir)
  const server = await createParseServer({
    dataDir,
    parserVersion: '0.1.0',
    parserFingerprint: 'async-contract-test',
    maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const upload = async (bytes: Uint8Array) => {
    const response = await request('/v1/files', { method: 'POST', body: Buffer.from(bytes) })
    expect(response.status, await response.clone().text()).toBe(201)
    return ((await response.json()) as { fileId: string }).fileId
  }
  const openAsync = (fileId: string) =>
    request('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId }),
    })
  const waitReady = async (sessionId: string) => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const response = await request(`/v1/sessions/${sessionId}`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { state: string }
      if (body.state === 'ready') return
      if (body.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return { server, request, upload, openAsync, waitReady }
}

it('v1 ready view exposes artifact identity and terminal progress consistently', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const opened = await h.openAsync(fileId)
  expect(opened.status).toBe(202)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  await h.waitReady(sessionId)
  const ready = (await (await h.request(`/v1/sessions/${sessionId}`)).json()) as Record<
    string,
    unknown
  >
  expect(ready).toMatchObject({
    sessionId,
    state: 'ready',
    pollAfterMs: 0,
    complete: true,
    artifactKey: artifactKey(
      ArtifactSession.identity({
        fileId,
        format: 'pptx',
        parserVersion: '0.1.0',
        parserFingerprint: 'async-contract-test',
      }),
    ),
  })
  const unitCount = (ready.model as { unitCount: number }).unitCount
  expect(ready.progress).toEqual({ unitsProduced: unitCount, unitCount, percent: 100 })

  const v1 = (await (await h.request(`/v1/sessions/${sessionId}`)).json()) as Record<
    string,
    unknown
  >
  expect(v1).toMatchObject({ sessionId, state: 'ready' })
  expect(v1).toMatchObject({ ...ready, expiresAt: expect.any(Number) })
  expect(Number(v1.expiresAt)).toBeGreaterThanOrEqual(Number(ready.expiresAt))
})

it('heartbeat renews a lightweight reading session and rejects unknown ids', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const opened = await h.openAsync(fileId)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  await h.waitReady(sessionId)
  const ready = await h.request(`/v1/sessions/${sessionId}/heartbeat`, { method: 'POST' })
  expect(ready.status).toBe(200)
  expect(await ready.json()).toMatchObject({ sessionId, state: 'ready', pollAfterMs: 0 })

  // A cold build keeps its durable waiter; heartbeat touches it without starting
  // a build or changing the wait state semantics.
  const coldFileId = await h.upload(await markedPptx('cold-heartbeat'))
  const cold = await h.openAsync(coldFileId)
  expect(cold.status).toBe(202)
  const coldId = ((await cold.json()) as { sessionId: string }).sessionId
  const pendingBeat = await h.request(`/v1/sessions/${coldId}/heartbeat`, { method: 'POST' })
  expect(pendingBeat.status).toBe(200)
  const pendingBody = (await pendingBeat.json()) as { state: string; pollAfterMs: number }
  expect(['queued', 'building']).toContain(pendingBody.state)
  expect(pendingBody.pollAfterMs).toBe(500)
  await h.waitReady(coldId)

  const unknown = await h.request(`/v1/sessions/${randomUUID()}/heartbeat`, { method: 'POST' })
  expect(unknown.status).toBe(404)
})

it('replays an Idempotency-Key create instead of opening a second waiter', async () => {
  const h = await setup()
  const fileId = await h.upload(await markedPptx('idempotent-create'))
  const post = (key?: string) =>
    h.request('/v1/sessions', {
      method: 'POST',
      headers: {
        ...{
          'Content-Type': 'application/json',
          ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        },
        Prefer: 'respond-async',
      },
      body: JSON.stringify({ fileId }),
    })
  const first = await post('retry:key-12345')
  expect(first.status).toBe(202)
  const created = (await first.json()) as { sessionId: string; jobId: string }
  // A retry during the build (or just after it) must address the same session.
  const retry = await post('retry:key-12345')
  expect([201, 202]).toContain(retry.status)
  expect(((await retry.json()) as { sessionId: string }).sessionId).toBe(created.sessionId)
  await h.waitReady(created.sessionId)
  const replay = await post('retry:key-12345')
  expect(replay.status).toBe(201)
  expect(await replay.json()).toMatchObject({ sessionId: created.sessionId, state: 'ready' })
  // A different key is a different business request: a fresh session id.
  const other = await post('retry:key-67890')
  expect(other.status).toBe(201)
  expect(((await other.json()) as { sessionId: string }).sessionId).not.toBe(created.sessionId)
  // Malformed keys fail before any durable state is created.
  const invalid = await post('bad key!')
  expect(invalid.status).toBe(400)
  const health = (await (await h.request('/v1/health')).json()) as {
    idempotency: { entries: number; hits: number; misses: number }
  }
  expect(health.idempotency.entries).toBeGreaterThan(0)
  expect(health.idempotency.hits).toBeGreaterThan(0)
  expect(health.idempotency.misses).toBeGreaterThan(0)
})

it('bundle-manifest aliases the existing bundle route without sub-resources', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const opened = await h.openAsync(fileId)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  await h.waitReady(sessionId)
  const bundle = await h.request(`/v1/sessions/${sessionId}/bundle`)
  expect(bundle.status).toBe(200)
  const manifest = (await bundle.json()) as Record<string, unknown>
  const alias = await h.request(`/v1/sessions/${sessionId}/bundle-manifest`)
  expect(alias.status).toBe(200)
  expect(await alias.json()).toEqual(manifest)
  const sub = await h.request(`/v1/sessions/${sessionId}/bundle-manifest/resources/layout/0.json`)
  expect(sub.status).toBe(404)
})

it('emits canonical v1 locations and resource URLs through the compatibility adapter', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const key = randomUUID()
  const init = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ fileId }),
  }
  const legacy = await h.request('/v2/sessions', init)
  expect(legacy.status).toBe(202)
  const created = (await legacy.json()) as { sessionId: string; dtoVersion: number }
  expect(created.dtoVersion).toBe(1)
  expect(legacy.headers.get('location')).toBe(`/v1/sessions/${created.sessionId}`)
  const retry = await h.request('/v1/sessions', {
    ...init,
    headers: { ...init.headers, Prefer: 'respond-async' },
  })
  expect(((await retry.json()) as { sessionId: string }).sessionId).toBe(created.sessionId)
  await h.waitReady(created.sessionId)
  for (const version of ['v1', 'v2']) {
    const caps = (await (await h.request(`/${version}/capabilities`)).json()) as {
      contractVersion: number
      dtoVersion: number
    }
    expect(caps).toMatchObject({ contractVersion: 1, dtoVersion: 1 })
    const bundle = await h.request(`/${version}/sessions/${created.sessionId}/bundle`)
    expect(bundle.status).toBe(200)
    const manifest = (await bundle.json()) as { resources: { href: string }[] }
    expect(manifest.resources.length).toBeGreaterThan(0)
    expect(manifest.resources.every((resource) => resource.href.startsWith('/v1/'))).toBe(true)
    expect((await h.request(`/${version}/library`)).status).toBe(200)
  }
  const model = await (await h.request(`/v2/sessions/${created.sessionId}/units/0`)).json()
  const canonical = await (
    await h.request(`/v1/sessions/${created.sessionId}/units/0?representation=model`)
  ).json()
  expect(canonical).toEqual(model)
  const rendered = (await (
    await h.request(`/v1/sessions/${created.sessionId}/units/0`)
  ).json()) as { slide: { widthPx: number } }
  expect(rendered.slide.widthPx).toBeGreaterThan(0)
  expect((await h.request(`/v2/sessions/${created.sessionId}`, { method: 'DELETE' })).status).toBe(
    204,
  )
  expect((await h.request(`/v1/sessions/${created.sessionId}`)).status).toBe(404)
})

it('applies the same authentication and CORS policy to canonical and legacy routes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'api-v1-auth-'))
  dirs.push(dataDir)
  const origin = 'https://viewer.example'
  const server = await createParseServer({
    dataDir,
    token: 'test-secret',
    allowedOrigins: [origin],
  })
  servers.push(server)
  for (const version of ['v1', 'v2']) {
    const preflight = await fetch(`${server.url}/${version}/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'prefer,authorization,idempotency-key',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Prefer')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Idempotency-Key')
    const rejected = await fetch(`${server.url}/${version}/sessions`, {
      method: 'POST',
      headers: { Prefer: 'respond-async' },
      body: '{}',
    })
    expect(rejected.status).toBe(401)
    const authorized = await fetch(`${server.url}/${version}/library`, {
      headers: { Authorization: 'Bearer test-secret', Origin: origin },
    })
    expect(authorized.status).toBe(200)
    expect(authorized.headers.get('access-control-expose-headers')).toContain(
      'X-Genoffice-Dto-Version',
    )
    expect(authorized.headers.get('x-genoffice-dto-version')).toBe('1')
    expect((await fetch(`${server.url}/${version}/capabilities`)).status).toBe(200)
  }
  for (const prefix of ['v20', 'v2x'])
    expect(
      (
        await fetch(`${server.url}/${prefix}/capabilities`, {
          headers: { Authorization: 'Bearer test-secret' },
        })
      ).status,
    ).toBe(404)
})
