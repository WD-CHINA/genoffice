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
  zip.file('v2-contract-marker.txt', marker)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup() {
  const dataDir = await mkdtemp(join(tmpdir(), 'v2-contract-'))
  dirs.push(dataDir)
  const server = await createParseServer({
    dataDir,
    parserVersion: '0.1.0',
    parserFingerprint: 'v2-contract-test',
    maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  const upload = async (bytes: Uint8Array) => {
    const response = await request('/v1/files', { method: 'POST', body: Buffer.from(bytes) })
    expect(response.status, await response.clone().text()).toBe(201)
    return ((await response.json()) as { fileId: string }).fileId
  }
  const openV2 = (fileId: string) => request('/v2/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId }),
  })
  const waitReady = async (sessionId: string) => {
    const deadline = Date.now() + 20_000
    for (;;) {
      const response = await request(`/v2/sessions/${sessionId}`)
      expect(response.status).toBe(200)
      const body = await response.json() as { state: string }
      if (body.state === 'ready') return
      if (body.state === 'failed') throw new Error('session failed')
      if (Date.now() > deadline) throw new Error('session did not become ready')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  return { server, request, upload, openV2, waitReady }
}

it('v2 ready view exposes the artifact identity and terminal progress; v1 stays unchanged', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const opened = await h.openV2(fileId)
  expect(opened.status).toBe(202)
  const { sessionId } = await opened.json() as { sessionId: string }
  await h.waitReady(sessionId)
  const v2 = await (await h.request(`/v2/sessions/${sessionId}`)).json() as Record<string, unknown>
  expect(v2).toMatchObject({
    sessionId,
    state: 'ready',
    pollAfterMs: 0,
    complete: true,
    artifactKey: artifactKey(
      ArtifactSession.identity({
        fileId,
        format: 'pptx',
        parserVersion: '0.1.0',
        parserFingerprint: 'v2-contract-test',
      }),
    ),
  })
  const unitCount = (v2.model as { unitCount: number }).unitCount
  expect(v2.progress).toEqual({ unitsProduced: unitCount, unitCount, percent: 100 })

  const v1 = await (await h.request(`/v1/sessions/${sessionId}`)).json() as Record<string, unknown>
  expect(v1).toMatchObject({ sessionId, state: 'ready' })
  expect(v1.artifactKey).toBeUndefined()
  expect(v1.progress).toBeUndefined()
  expect(v1.pollAfterMs).toBeUndefined()
})

it('heartbeat renews a lightweight reading session and rejects unknown ids', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const opened = await h.openV2(fileId)
  const { sessionId } = await opened.json() as { sessionId: string }
  await h.waitReady(sessionId)
  const ready = await h.request(`/v2/sessions/${sessionId}/heartbeat`, { method: 'POST' })
  expect(ready.status).toBe(200)
  expect(await ready.json()).toMatchObject({ sessionId, state: 'ready', pollAfterMs: 0 })

  // A cold build keeps its durable waiter; heartbeat touches it without starting
  // a build or changing the wait state semantics.
  const coldFileId = await h.upload(await markedPptx('cold-heartbeat'))
  const cold = await h.openV2(coldFileId)
  expect(cold.status).toBe(202)
  const coldId = (await cold.json() as { sessionId: string }).sessionId
  const pendingBeat = await h.request(`/v2/sessions/${coldId}/heartbeat`, { method: 'POST' })
  expect(pendingBeat.status).toBe(200)
  const pendingBody = await pendingBeat.json() as { state: string; pollAfterMs: number }
  expect(['queued', 'building']).toContain(pendingBody.state)
  expect(pendingBody.pollAfterMs).toBe(500)
  await h.waitReady(coldId)

  const unknown = await h.request(`/v2/sessions/${randomUUID()}/heartbeat`, { method: 'POST' })
  expect(unknown.status).toBe(404)
})

it('replays an Idempotency-Key create instead of opening a second waiter', async () => {
  const h = await setup()
  const fileId = await h.upload(await markedPptx('idempotent-create'))
  const post = (key?: string) => h.request('/v2/sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }),
    },
    body: JSON.stringify({ fileId }),
  })
  const first = await post('retry:key-12345')
  expect(first.status).toBe(202)
  const created = await first.json() as { sessionId: string; jobId: string }
  // A retry during the build (or just after it) must address the same session.
  const retry = await post('retry:key-12345')
  expect([201, 202]).toContain(retry.status)
  expect((await retry.json() as { sessionId: string }).sessionId).toBe(created.sessionId)
  await h.waitReady(created.sessionId)
  const replay = await post('retry:key-12345')
  expect(replay.status).toBe(201)
  expect(await replay.json()).toMatchObject({ sessionId: created.sessionId, state: 'ready' })
  // A different key is a different business request: a fresh session id.
  const other = await post('retry:key-67890')
  expect(other.status).toBe(201)
  expect((await other.json() as { sessionId: string }).sessionId).not.toBe(created.sessionId)
  // Malformed keys fail before any durable state is created.
  const invalid = await post('bad key!')
  expect(invalid.status).toBe(400)
  const health = await (await h.request('/v1/health')).json() as {
    idempotency: { entries: number; hits: number; misses: number }
  }
  expect(health.idempotency.entries).toBeGreaterThan(0)
  expect(health.idempotency.hits).toBeGreaterThan(0)
  expect(health.idempotency.misses).toBeGreaterThan(0)
})

it('bundle-manifest aliases the existing bundle route without sub-resources', async () => {
  const h = await setup()
  const fileId = await h.upload(await createBlankPptx())
  const opened = await h.openV2(fileId)
  const { sessionId } = await opened.json() as { sessionId: string }
  await h.waitReady(sessionId)
  const bundle = await h.request(`/v2/sessions/${sessionId}/bundle`)
  expect(bundle.status).toBe(200)
  const manifest = await bundle.json() as Record<string, unknown>
  const alias = await h.request(`/v2/sessions/${sessionId}/bundle-manifest`)
  expect(alias.status).toBe(200)
  expect(await alias.json()).toEqual(manifest)
  const sub = await h.request(`/v2/sessions/${sessionId}/bundle-manifest/resources/layout/0.json`)
  expect(sub.status).toBe(404)
})
