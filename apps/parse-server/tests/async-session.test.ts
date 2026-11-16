import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import { PptxSession } from '../src/pptx'
import { PendingSessionStore } from '../src/pending-session-store'

const directories: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function setup(options: Partial<ParseServerOptions> = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'async-parse-')))
  if (!options.dataDir) directories.push(dataDir)
  const server = await createParseServer({
    dataDir,
    token: 'secret',
    parserFingerprint: 'async-test-build',
    maxParseJobs: 1,
    maxQueuedParseJobs: 1,
    ...options,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
  const upload = async (marker = 'first') => {
    const zip = await JSZip.loadAsync(await createBlankPptx())
    zip.file('test-marker.txt', marker)
    const response = await request('/v1/files', {
      method: 'POST',
      body: await zip.generateAsync({ type: 'nodebuffer' }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { fileId: string }).fileId
  }
  const open = (fileId: string) =>
    request('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId }),
    })
  const ready = async (id: string) => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const response = await request(`/v1/sessions/${id}`)
      expect(response.status).toBe(200)
      const status = (await response.json()) as { state: string; error?: unknown; model?: unknown }
      if (status.state === 'ready') return status
      expect(status.state, JSON.stringify(status.error)).not.toBe('failed')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('async session did not become ready')
  }
  return { server, dataDir, request, upload, open, ready }
}

it('returns 202 before parsing finishes, shares the job, and keeps the other viewer alive after cancellation', async () => {
  const harness = await setup()
  const fileId = await harness.upload()
  const blocked = gate()
  const entered = gate()
  const original = PptxSession.open.bind(PptxSession)
  const parse = vi.spyOn(PptxSession, 'open').mockImplementation(async (input) => {
    entered.resolve()
    await blocked.promise
    return original(input)
  })
  let secondId: string | undefined
  try {
    const firstResponse = await harness.open(fileId)
    expect(firstResponse.status).toBe(202)
    const first = (await firstResponse.json()) as { sessionId: string; jobId: string }
    expect(firstResponse.headers.get('Location')).toBe(`/v1/sessions/${first.sessionId}`)
    await entered.promise
    const secondResponse = await harness.open(fileId)
    expect(secondResponse.status).toBe(202)
    const second = (await secondResponse.json()) as { sessionId: string; jobId: string }
    secondId = second.sessionId
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(first.jobId).toBe(second.jobId)
    expect(parse).toHaveBeenCalledTimes(1)
    const status = await (await harness.request(`/v1/sessions/${second.sessionId}`)).json()
    expect(status).toMatchObject({ state: 'building' })
    expect(
      (await harness.request(`/v1/sessions/${second.sessionId}/units/0?representation=model`))
        .status,
    ).toBe(409)
    expect((await harness.request(`/v1/files/${fileId}`, { method: 'DELETE' })).status).toBe(409)
    expect(
      (await harness.request(`/v1/sessions/${first.sessionId}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect((await harness.request(`/v1/sessions/${first.sessionId}`)).status).toBe(404)
  } finally {
    blocked.resolve()
  }
  await harness.ready(secondId!)
  expect((await harness.request(`/v1/sessions/${secondId}/layout/slides/0`)).status).toBe(200)
  const hot = await harness.open(fileId)
  expect(hot.status).toBe(201)
  expect(await hot.json()).toMatchObject({ state: 'ready' })
  expect(parse).toHaveBeenCalledTimes(1)
})

it('rejects excess unique cold work with 429 while allowing a ready cached document', async () => {
  const harness = await setup({ maxQueuedParseJobs: 0 })
  const warm = await harness.upload('warm')
  const warmResponse = await harness.open(warm)
  const warmId = ((await warmResponse.json()) as { sessionId: string }).sessionId
  await harness.ready(warmId)
  const cold = await harness.upload('cold')
  const rejectedFile = await harness.upload('rejected')
  const blocked = gate()
  const entered = gate()
  const original = PptxSession.open.bind(PptxSession)
  vi.spyOn(PptxSession, 'open').mockImplementation(async (input) => {
    entered.resolve()
    await blocked.promise
    return original(input)
  })
  let coldId: string | undefined
  try {
    const coldResponse = await harness.open(cold)
    expect(coldResponse.status).toBe(202)
    coldId = ((await coldResponse.json()) as { sessionId: string }).sessionId
    await entered.promise
    const full = await harness.open(rejectedFile)
    expect(full.status).toBe(429)
    expect(await full.json()).toMatchObject({ code: 'parse_queue_full' })
    expect((await harness.open(warm)).status).toBe(201)
  } finally {
    blocked.resolve()
  }
  await harness.ready(coldId!)
})

it('resumes queued durable sessions after shutdown and reuses an artifact completed during shutdown', async () => {
  const first = await setup()
  const one = await first.upload('one')
  const two = await first.upload('two')
  const blocked = gate()
  const entered = gate()
  const original = PptxSession.open.bind(PptxSession)
  const parse = vi.spyOn(PptxSession, 'open').mockImplementation(async (input) => {
    entered.resolve()
    await blocked.promise
    return original(input)
  })
  const firstResponse = await first.open(one)
  const a = (await firstResponse.json()) as { sessionId: string }
  await entered.promise
  const secondResponse = await first.open(two)
  expect(secondResponse.status).toBe(202)
  const b = (await secondResponse.json()) as { sessionId: string }
  expect(await (await first.request(`/v1/sessions/${b.sessionId}`)).json()).toMatchObject({
    state: 'queued',
  })
  const closing = first.server.close()
  blocked.resolve()
  await closing
  parse.mockClear()
  const second = await setup({ dataDir: first.dataDir })
  await Promise.all([second.ready(a.sessionId), second.ready(b.sessionId)])
  expect(parse).toHaveBeenCalledTimes(1)
  expect((await second.request(`/v1/sessions/${a.sessionId}/layout/slides/0`)).status).toBe(200)
  await second.server.close()
  const journal = new PendingSessionStore(first.dataDir)
  await journal.init(15 * 60_000)
  expect(journal.values()).toEqual([])
})

it('exposes a failed async job and never claims its partial output is ready', async () => {
  const harness = await setup({ workerMemoryMb: 16, workerRssMb: 64, rssSampleMs: 10 })
  const fileId = await harness.upload('failure')
  const response = await harness.open(fileId)
  expect(response.status).toBe(202)
  const opened = (await response.json()) as { sessionId: string }
  let status: any
  const deadline = Date.now() + 5000
  do {
    status = await (await harness.request(`/v1/sessions/${opened.sessionId}`)).json()
    if (status.state === 'failed') break
    expect(status.state).not.toBe('ready')
    await new Promise((resolve) => setTimeout(resolve, 10))
  } while (Date.now() < deadline)
  expect(status).toMatchObject({
    state: 'failed',
    error: { code: 'parse_memory_limit', status: 422 },
  })
  expect(
    (await harness.request(`/v1/sessions/${opened.sessionId}/units/0?representation=model`)).status,
  ).toBe(409)
  expect(
    (await harness.request(`/v1/sessions/${opened.sessionId}`, { method: 'DELETE' })).status,
  ).toBe(204)
  expect((await harness.request(`/v1/sessions/${opened.sessionId}`)).status).toBe(404)
})

it('exposes legacy file aliases and returns persisted models without starting a layout child', async () => {
  const harness = await setup()
  const upload = await harness.request('/v1/files', {
    method: 'POST',
    body: Buffer.from(await createBlankPptx()),
  })
  expect(upload.status).toBe(201)
  const { fileId } = (await upload.json()) as { fileId: string }
  expect((await harness.request(`/v1/files/${fileId}`)).status).toBe(200)
  const opened = await harness.open(fileId)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  await harness.ready(sessionId)
  const document = await harness.request(`/v1/sessions/${sessionId}/document`)
  expect(await document.json()).toMatchObject({
    model: { format: 'pptx' },
    layout: { slideCount: 1 },
  })
  const model = await harness.request(`/v1/sessions/${sessionId}/units/0?representation=model`)
  expect(await model.json()).toHaveProperty('size')
  const health = (await (await harness.request('/v1/health')).json()) as { activeWorkers: number }
  expect(health.activeWorkers).toBe(0)
  const signed = (await (await harness.request(`/v1/files/${fileId}/content-url`)).json()) as {
    url: string
  }
  const content = await fetch(signed.url.replace('/v1/files/', '/v2/files/'), {
    headers: { Range: 'bytes=0-3' },
  })
  expect(content.status).toBe(206)
  expect((await fetch(`${harness.server.url}/v1/files/${fileId}/content`)).status).toBe(401)
})
