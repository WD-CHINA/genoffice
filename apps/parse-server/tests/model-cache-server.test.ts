import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'

const directories: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(options: Partial<ParseServerOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'parse-cache-'))
  directories.push(dataDir)
  const server = await createParseServer({ dataDir, token: 'secret', ...options })
  servers.push(server)
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
  return { server, request }
}

async function openSession(request: (path: string, init?: RequestInit) => Promise<Response>) {
  const uploaded = await request('/v1/files', { method: 'POST', body: Buffer.from(await createBlankPptx()) })
  expect(uploaded.status).toBe(201)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  const opened = await request('/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(opened.status).toBe(201)
  return { fileId, sessionId: ((await opened.json()) as { sessionId: string }).sessionId }
}

it('serves repeated model reads from the byte-bounded cache and exposes stats', async () => {
  const { request } = await setup()
  const { sessionId } = await openSession(request)
  for (let attempt = 0; attempt < 3; attempt++) {
    const slide = await request(`/v1/sessions/${sessionId}/layout/slides/0`)
    expect(slide.status, await slide.clone().text()).toBe(200)
    await slide.json()
  }
  const health = (await (await request('/v1/health')).json()) as any
  expect(health.memoryCache.budgetBytes).toBe(2 * 1024 ** 3)
  expect(health.memoryCache.model.maxBytes).toBe(256 * 1024 ** 2)
  expect(health.memoryCache.model.hits).toBeGreaterThan(0)
  expect(health.memoryCache.model.bytes).toBeGreaterThan(0)
  expect(health.memoryCache.model.bytes).toBeLessThanOrEqual(health.memoryCache.model.maxBytes)

  const metrics = await (await request('/metrics')).text()
  expect(metrics).toContain('genoffice_parse_model_cache_bytes')
  expect(metrics).toContain('genoffice_parse_model_cache_hits_total')
  expect(metrics).toContain('genoffice_parse_http_concurrency_limit')
})

it('never exceeds a small configured byte budget', async () => {
  const { request } = await setup({ modelCacheMaxBytes: 512 })
  const { sessionId } = await openSession(request)
  const slide = await request(`/v1/sessions/${sessionId}/layout/slides/0`)
  expect(slide.status, await slide.clone().text()).toBe(200)
  await slide.json()
  const health = (await (await request('/v1/health')).json()) as any
  expect(health.memoryCache.model.maxBytes).toBe(512)
  expect(health.memoryCache.model.bytes).toBeLessThanOrEqual(512)
})

it('rejects excess HTTP concurrency with 503 but keeps health and metrics reachable', async () => {
  const { server, request } = await setup({ httpMaxConcurrency: 1 })
  const held = httpRequest(`${server.url}/v1/files`, {
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
  })
  held.on('error', () => undefined)
  held.write(Buffer.from('%PDF-1.7\npartial body'))
  try {
    // The held upload occupies the single handler slot.
    await delay(100)
    const busy = await request('/v1/capabilities')
    expect(busy.status).toBe(503)
    expect(((await busy.json()) as { code?: string }).code).toBe('server_busy')
    expect((await request('/v1/health')).status).toBe(200)
    expect((await request('/metrics')).status).toBe(200)
    const health = (await (await request('/v1/health')).json()) as any
    expect(health.http.maxConcurrency).toBe(1)
    // The health request itself is counted, so the held upload plus this probe.
    expect(health.http.inFlight).toBeGreaterThanOrEqual(1)
    expect(health.http.rejected).toBeGreaterThan(0)
  } finally {
    held.destroy()
  }
  await delay(100)
  expect((await request('/v1/capabilities')).status).toBe(200)
})
