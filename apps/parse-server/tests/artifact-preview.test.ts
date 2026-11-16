import { serverRoot } from './helpers/paths'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer } from '../src/server'
import { PptxSession } from '../src/pptx'
import { DocxSession } from '../src/docx-session'
import { ArtifactStore } from '../src/artifact-store'
import { canonicalResources, modelDto } from '../src/artifact-session'

const servers: ParseServer[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup(dataDir?: string, parserVersion?: string) {
  const dir = dataDir ?? (await mkdtemp(join(tmpdir(), 'artifact-preview-')))
  if (!dataDir) directories.push(dir)
  const server = await createParseServer({
    dataDir: dir,
    parserVersion,
    token: 'secret',
    maxParseJobs: 1,
    maxQueuedParseJobs: 0,
  })
  servers.push(server)
  const headers = { Authorization: 'Bearer secret' }
  const json = async (path: string, init?: RequestInit): Promise<any> => {
    const response = await fetch(server.url + path, {
      ...init,
      headers: { ...headers, ...init?.headers },
    })
    expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
    return response.status === 204 ? null : response.json()
  }
  const open = (fileId: string) =>
    json('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
  const upload = (body: Buffer) => json('/v1/files', { method: 'POST', body })
  return { dir, server, json, open, upload }
}

it('shares one PPTX parse across sessions, persists models, and reopens after restart without parsing', async () => {
  const first = await setup()
  const parse = vi.spyOn(PptxSession, 'open')
  const uploaded = await first.upload(Buffer.from(await createBlankPptx()))
  const sessions = await Promise.all([first.open(uploaded.fileId), first.open(uploaded.fileId)])
  expect(parse).toHaveBeenCalledTimes(1)
  const source = await first.json(`/v1/sessions/${sessions[0].sessionId}/layout/slides/0`)
  expect(source.slide).toBeDefined()
  expect((await first.json('/v1/health')).activeWorkers).toBe(0)
  for (const session of sessions)
    await first.json(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
  expect(await new ArtifactStore(first.dir).list()).toHaveLength(1)
  await first.server.close()
  parse.mockClear()
  const second = await setup(first.dir)
  const reopened = await second.open(uploaded.fileId)
  expect(await second.json(`/v1/sessions/${reopened.sessionId}/layout/slides/0`)).toEqual(source)
  expect(parse).not.toHaveBeenCalled()
  expect((await second.json('/v1/health')).activeWorkers).toBe(0)
  // Legacy server-side layout also reads persisted models, without calling the parser.
  const render = await second.json(`/v1/sessions/${reopened.sessionId}/units/0`)
  expect(render.slide.widthPx).toBeGreaterThan(0)
  expect(parse).not.toHaveBeenCalled()
})

for (const fixture of ['image.docx', 'font.docx', 'table.docx']) {
  it(`persists ${fixture} blocks/styles/fonts and reuses them after every session closes and the server restarts`, async () => {
    const first = await setup()
    const parse = vi.spyOn(DocxSession, 'open')
    const uploaded = await first.upload(
      await readFile(join(serverRoot, 'tests/fixtures/docx', fixture)),
    )
    const session = await first.open(uploaded.fileId)
    expect(parse).toHaveBeenCalledTimes(1)
    const blocks = await first.json(`/v1/sessions/${session.sessionId}/units/0`)
    const styles = await first.json(`/v1/sessions/${session.sessionId}/styles`)
    const fontBytes: Buffer[] = []
    for (const font of session.fonts) {
      const response = await fetch(
        `${first.server.url}/v1/sessions/${session.sessionId}/fonts/${encodeURIComponent(font.id)}`,
        { headers: { Authorization: 'Bearer secret' } },
      )
      expect(response.status).toBe(200)
      fontBytes.push(Buffer.from(await response.arrayBuffer()))
    }
    await first.json(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
    await first.server.close()
    parse.mockClear()
    const second = await setup(first.dir)
    const reopened = await second.open(uploaded.fileId)
    const restored = await second.json(`/v1/sessions/${reopened.sessionId}/units/0`)
    expect(canonicalResources(modelDto(restored), uploaded.fileId)).toEqual(
      canonicalResources(modelDto(blocks), uploaded.fileId),
    )
    expect(await second.json(`/v1/sessions/${reopened.sessionId}/styles`)).toEqual(styles)
    for (const [index, font] of reopened.fonts.entries()) {
      const response = await fetch(
        `${second.server.url}/v1/sessions/${reopened.sessionId}/fonts/${encodeURIComponent(font.id)}`,
        { headers: { Authorization: 'Bearer secret' } },
      )
      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(fontBytes[index])
    }
    const urls: string[] = []
    function collect(value: unknown): void {
      if (typeof value === 'string' && value.includes(`/v1/files/${uploaded.fileId}/parts/`))
        urls.push(value)
      else if (Array.isArray(value)) value.forEach(collect)
      else if (value && typeof value === 'object') Object.values(value).forEach(collect)
    }
    collect(restored)
    if (fixture === 'image.docx') expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(new URL(url).origin).toBe(second.server.url)
      expect((await fetch(url)).status).toBe(200)
      expect((await fetch(url.replace(/\?.*$/, ''))).status).toBe(401)
    }
    expect(parse).not.toHaveBeenCalled()
    expect((await second.json('/v1/health')).activeWorkers).toBe(0)
    const [artifact] = await new ArtifactStore(first.dir).list()
    const persisted = JSON.stringify(await artifact.read('unit:0'))
    expect(persisted).not.toContain('sig=')
    expect(persisted).not.toContain('artifact.invalid')
  })
}

it('invalidates artifacts on parser version changes while retaining the prior generation', async () => {
  const first = await setup(undefined, 'parser-1')
  const uploaded = await first.upload(Buffer.from(await createBlankPptx()))
  await first.open(uploaded.fileId)
  await first.server.close()
  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(first.dir, 'parser-2')
  await second.open(uploaded.fileId)
  expect(parse).toHaveBeenCalledTimes(1)
  expect(await new ArtifactStore(first.dir).list()).toHaveLength(2)
})

it('serves cached sessions while a cold build fills the parse queue, and rejects only new cold jobs', async () => {
  const harness = await setup()
  const blank = Buffer.from(await createBlankPptx())
  const warm = await harness.upload(blank)
  await harness.open(warm.fileId)
  const cold = []
  for (const name of ['one', 'two']) {
    const zip = await JSZip.loadAsync(blank)
    zip.file('test-marker.txt', name)
    cold.push(await harness.upload(await zip.generateAsync({ type: 'nodebuffer' })))
  }
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = PptxSession.open.bind(PptxSession)
  const parse = vi.spyOn(PptxSession, 'open').mockImplementation(async (input) => {
    entered()
    await gate
    return original(input)
  })
  const building = harness.open(cold[0].fileId)
  try {
    await started
    const cached = await Promise.all(Array.from({ length: 10 }, () => harness.open(warm.fileId)))
    expect(cached).toHaveLength(10)
    expect(parse).toHaveBeenCalledTimes(1)
    const full = await fetch(`${harness.server.url}/v1/sessions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: cold[1].fileId }),
    })
    expect(full.status).toBe(429)
    expect(await full.json()).toMatchObject({ code: 'parse_queue_full' })
    expect((await harness.json('/v1/health')).parseQueue).toEqual({ running: 1, queued: 0 })
  } finally {
    release()
    await building
  }
})

it('repairs a corrupt persisted manifest through the asynchronous API without deleting the original', async () => {
  const app = await setup()
  const parse = vi.spyOn(PptxSession, 'open')
  const uploaded = await app.upload(Buffer.from(await createBlankPptx()))
  const session = await app.open(uploaded.fileId)
  await app.json(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
  const [artifact] = await new ArtifactStore(app.dir).list()
  await writeFile(join(artifact.directory, 'manifest.json'), '{corrupt')
  const waiting = await app.json('/v1/sessions', {
    method: 'POST',
    headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
    body: JSON.stringify({ fileId: uploaded.fileId }),
  })
  let ready = waiting
  // A corrupt-ready repair re-parses in an isolated worker; keep the poll
  // bounded but generous enough for a loaded CI machine (~10 s).
  for (let attempt = 0; attempt < 500 && ready.state !== 'ready'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    ready = await app.json(`/v1/sessions/${waiting.sessionId}`)
    expect(ready.state).not.toBe('failed')
  }
  expect(ready.state).toBe('ready')
  expect(parse).toHaveBeenCalledTimes(2)
  expect(
    await app.json(`/v1/sessions/${waiting.sessionId}/units/0?representation=model`),
  ).toHaveProperty('slide')
  expect(await app.json(`/v1/files/${uploaded.fileId}`)).toHaveProperty('fileId', uploaded.fileId)
})
