import { serverRoot } from './helpers/paths'
import JSZip from 'jszip'
import { request as httpRequest } from 'node:http'
import { StorageBudget, StorageFullError } from '../src/storage-budget'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as tick } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import { LibraryStore } from '../src/library-store'
import { ArtifactStore } from '../src/artifact-store'
import { PptxSession } from '../src/pptx'

const directories: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup(options: Partial<ParseServerOptions> = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'history-library-')))
  if (!options.dataDir) directories.push(dataDir)
  const server = await createParseServer({ dataDir, token: 'secret', ...options })
  servers.push(server)
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
  const post = (path: string, body: unknown) =>
    request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const upload = async (bytes: Buffer) => {
    const response = await request('/v1/files', { method: 'POST', body: bytes })
    expect(response.status).toBe(201)
    return (await response.json()) as { fileId: string; createdAt: string }
  }
  return { dataDir, server, request, post, upload }
}

it('saved originals and artifacts survive TTL/GC/restart; deleting the library reference restores temporary GC', async () => {
  const first = await setup({ contentTtlMs: 1 })
  const file = await first.upload(Buffer.from(await createBlankPptx()))
  const opened = await first.post('/v1/sessions', { fileId: file.fileId })
  expect(opened.status).toBe(201)
  const { sessionId } = (await opened.json()) as { sessionId: string }
  const saved = await first.post('/v2/library', { fileId: file.fileId, displayName: '年度计划' })
  expect(saved.status).toBe(201)
  const entry = (await saved.json()) as { id: string }
  await first.request(`/v1/sessions/${sessionId}`, { method: 'DELETE' })
  const meta = await first.server.store.stat(file.fileId)
  await writeFile(
    join(first.dataDir, 'meta', `${file.fileId}.json`),
    JSON.stringify({ ...meta, createdAt: '2000-01-01T00:00:00.000Z' }),
  )
  await first.server.gc()
  expect(await first.server.store.pathOf(file.fileId)).not.toBeNull()
  expect(await new ArtifactStore(first.dataDir).list()).toHaveLength(1)
  expect((await first.request(`/v1/files/${file.fileId}`, { method: 'DELETE' })).status).toBe(409)
  await first.server.close()
  const second = await setup({ dataDir: first.dataDir, contentTtlMs: 1 })
  await second.server.gc()
  const listing = await second.request('/v2/library')
  expect(await listing.json()).toMatchObject({
    items: [{ id: entry.id, displayName: '年度计划', fileId: file.fileId, retention: 'saved' }],
  })
  const parse = vi.spyOn(PptxSession, 'open')
  const reopened = await second.post('/v1/sessions', { fileId: file.fileId })
  expect(reopened.status).toBe(201)
  const current = (await reopened.json()) as { sessionId: string }
  expect((await second.request(`/v1/sessions/${current.sessionId}/layout/slides/0`)).status).toBe(
    200,
  )
  expect(parse).not.toHaveBeenCalled()
  await second.request(`/v1/sessions/${current.sessionId}`, { method: 'DELETE' })
  expect((await second.request(`/v2/library/${entry.id}`, { method: 'DELETE' })).status).toBe(204)
  await second.server.gc()
  expect(await second.server.store.stat(file.fileId)).toBeNull()
  expect(await new ArtifactStore(first.dataDir).list()).toHaveLength(0)
})

it('quota failure on a duplicate upload cannot remove a saved original', async () => {
  const first = await setup({ maxStoreBytes: 0 })
  const bytes = Buffer.from('%PDF-1.7\n%%EOF\n')
  const file = await first.upload(bytes)
  await first.post('/v2/library', { fileId: file.fileId, displayName: 'Saved PDF' })
  expect(await first.upload(bytes)).toEqual(
    expect.objectContaining({ fileId: file.fileId, createdAt: file.createdAt }),
  )
  await first.server.close()
  const second = await setup({ dataDir: first.dataDir, maxStoreBytes: 1 })
  const retry = await second.request('/v1/files', { method: 'POST', body: bytes })
  expect(retry.status).toBe(507)
  await second.server.gc()
  expect((await second.request(`/v1/files/${file.fileId}/content`)).status).toBe(200)
  expect(await second.server.store.stat(file.fileId)).toMatchObject({ createdAt: file.createdAt })
})

it('saving a file and GC coordinate so a successful save cannot point at deleted bytes', async () => {
  const harness = await setup({ contentTtlMs: 1 })
  const file = await harness.upload(Buffer.from('%PDF-1.7\n%%EOF\n'))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = LibraryStore.prototype.save
  vi.spyOn(LibraryStore.prototype, 'save').mockImplementation(async function (
    this: LibraryStore,
    fileId,
    name,
  ) {
    entered()
    await gate
    return original.call(this, fileId, name)
  })
  const saving = harness.post('/v2/library', { fileId: file.fileId })
  await started
  let collected = false
  const collecting = harness.server.gc().then(() => {
    collected = true
  })
  try {
    await tick()
    expect(collected).toBe(false)
  } finally {
    release()
  }
  expect((await saving).status).toBe(201)
  await collecting
  expect(await harness.server.store.pathOf(file.fileId)).not.toBeNull()
})

it('validates history requests, deduplicates saves, and paginates without repeating deleted cursor entries', async () => {
  const harness = await setup()
  expect((await fetch(`${harness.server.url}/v2/library`)).status).toBe(401)
  expect((await harness.post('/v2/library', null)).status).toBe(400)
  expect((await harness.post('/v2/library', { fileId: 'a'.repeat(64) })).status).toBe(404)
  const entries = []
  for (let index = 0; index < 3; index++) {
    const file = await harness.upload(Buffer.from(`%PDF-1.7\n${index}\n%%EOF\n`))
    const response = await harness.post('/v2/library', {
      fileId: file.fileId,
      displayName: `File ${index}`,
    })
    entries.push((await response.json()) as { id: string; fileId: string })
  }
  const updated = await harness.post('/v2/library', {
    fileId: entries[0].fileId,
    displayName: 'Renamed',
  })
  expect(await updated.json()).toMatchObject({ id: entries[0].id, displayName: 'Renamed' })
  expect((await harness.request('/v2/library?limit=0')).status).toBe(400)
  expect((await harness.request('/v2/library?cursor=invalid')).status).toBe(400)
  const firstPage = (await (await harness.request('/v2/library?limit=1')).json()) as {
    items: Array<{ id: string }>
    next: string
  }
  await harness.request(`/v2/library/${firstPage.items[0].id}`, { method: 'DELETE' })
  const rest = (await (
    await harness.request(`/v2/library?limit=2&cursor=${firstPage.next}`)
  ).json()) as { items: Array<{ id: string }> }
  expect(rest.items).toHaveLength(2)
  expect(rest.items.map((item) => item.id)).not.toContain(firstPage.items[0].id)
})

it('refuses startup with a corrupt retention index instead of treating saved originals as disposable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'corrupt-library-'))
  directories.push(directory)
  await writeFile(join(directory, 'library.json'), '[{"fileId":"invalid"}]')
  await expect(new LibraryStore(directory).init()).rejects.toThrow('unsafe retention')
  expect(await readFile(join(directory, 'library.json'), 'utf8')).toContain('invalid')
})

it('artifact quota exhaustion returns 507, releases reservations and preserves saved source for retry', async () => {
  const bytes = Buffer.from(await createBlankPptx())
  const first = await setup({ maxStoreBytes: bytes.length + 1 })
  const file = await first.upload(bytes)
  expect((await first.post('/v2/library', { fileId: file.fileId })).status).toBe(201)
  const opened = await first.post('/v1/sessions', { fileId: file.fileId })
  expect(opened.status).toBe(507)
  expect(await opened.json()).toMatchObject({ code: 'storage_full' })
  const health = (await (await first.request('/v1/health')).json()) as any
  expect(health.artifacts.reservedBytes).toBe(0)
  expect(health.artifacts.activeBuilds).toBe(0)
  expect(health.activeWorkers).toBe(0)
  expect(await readdir(join(first.dataDir, 'staging'))).toEqual([])
  expect((await first.request(`/v1/files/${file.fileId}/content`)).status).toBe(200)
  await first.server.close()
  const second = await setup({ dataDir: first.dataDir, maxStoreBytes: bytes.length + 1024 * 1024 })
  const retry = await second.post('/v1/sessions', { fileId: file.fileId })
  expect(retry.status).toBe(201)
  expect(await new ArtifactStore(first.dataDir).list()).toHaveLength(1)
})

it('temporary upload exhaustion returns HTTP 507 without destroying the response socket or leaking bytes', async () => {
  const app = await setup()
  const original = StorageBudget.prototype.reservation
  vi.spyOn(StorageBudget.prototype, 'reservation').mockImplementation(function (
    this: StorageBudget,
    options,
  ) {
    const reservation = original.call(this, options)
    if (!options?.temporary) return reservation
    return {
      get bytes() {
        return reservation.bytes
      },
      reserve: async () => {
        throw new StorageFullError()
      },
      release: reservation.release,
    }
  })
  const response = await app.request('/v1/files', {
    method: 'POST',
    body: Buffer.from('%PDF-1.7\n%%EOF\n'),
  })
  expect(response.status).toBe(507)
  expect(await response.json()).toMatchObject({ code: 'storage_full' })
  expect(await readdir(join(app.dataDir, 'tmp'))).toEqual([])
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.artifacts.reservedBytes).toBe(0)
})

it('a disconnected chunked HTTP upload releases its temporary reservation and can be retried', async () => {
  const app = await setup()
  const health = async () => (await (await app.request('/v1/health')).json()) as any
  const request = httpRequest(app.server.url + '/v1/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer secret' },
  })
  request.on('error', () => {})
  request.write(Buffer.from('%PDF-1.7\npartial body'))
  try {
    await vi.waitFor(async () =>
      expect((await health()).artifacts.reservedBytes).toBeGreaterThan(0),
    )
  } finally {
    request.destroy()
  }
  await vi.waitFor(async () => {
    expect((await health()).artifacts.reservedBytes).toBe(0)
    expect(await readdir(join(app.dataDir, 'tmp'))).toEqual([])
  })
  const retried = await app.upload(Buffer.from('%PDF-1.7\n%%EOF\n'))
  expect(retried.fileId).toHaveLength(64)
  expect((await health()).artifacts.reservedBytes).toBe(0)
})

it('unsupported uploads remove temporary bytes and release their reservation', async () => {
  const app = await setup()
  const response = await app.request('/v1/files', {
    method: 'POST',
    body: Buffer.from('plain text'),
  })
  expect(response.status).toBe(415)
  expect(await readdir(join(app.dataDir, 'tmp'))).toEqual([])
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.artifacts.reservedBytes).toBe(0)
})

it('encrypted Office containers are rejected explicitly instead of being treated as corrupt zips', async () => {
  const app = await setup()
  // OLE compound-file magic (CFB): what Word writes for a password-protected .docx.
  const container = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(504, 0),
  ])
  const response = await app.request('/v1/files', { method: 'POST', body: container })
  expect(response.status).toBe(415)
  const body = (await response.json()) as { code?: string; message?: string }
  expect(body.code).toBe('encrypted_document')
  expect(body.message).toContain('password')
  expect(await readdir(join(app.dataDir, 'tmp'))).toEqual([])
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.artifacts.reservedBytes).toBe(0)
})

it('DOCX scratch quota failure crosses the child-process protocol and frees chunks, worker and reservation', async () => {
  const bytes = await readFile(join(serverRoot, 'tests/fixtures/docx/table.docx'))
  const app = await setup({ maxStoreBytes: bytes.length + 1 })
  const file = await app.upload(bytes)
  expect((await app.post('/v2/library', { fileId: file.fileId })).status).toBe(201)
  const failed = await app.post('/v1/sessions', { fileId: file.fileId })
  expect(failed.status).toBe(507)
  expect(await failed.json()).toMatchObject({ code: 'storage_full' })
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.artifacts.reservedBytes).toBe(0)
  expect(health.artifacts.activeBuilds).toBe(0)
  expect(health.activeWorkers).toBe(0)
  expect(await readdir(join(app.dataDir, 'chunks'))).toEqual([])
  expect((await app.request(`/v1/files/${file.fileId}/content`)).status).toBe(200)
  await app.server.close()
  const larger = await setup({ dataDir: app.dataDir, maxStoreBytes: bytes.length + 1024 * 1024 })
  const ready = await larger.post('/v1/sessions', { fileId: file.fileId })
  expect(ready.status).toBe(201)
  const session = (await ready.json()) as { sessionId: string }
  const unit = await larger.request(`/v1/sessions/${session.sessionId}/units/0`)
  expect(unit.status).toBe(200)
  expect(((await unit.json()) as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0)
  expect(await readdir(join(app.dataDir, 'chunks'))).toEqual([])
})

it('storage pressure protects active cached readers, then evicts idle artifacts while retaining saved originals', async () => {
  const bytes = Buffer.from(await createBlankPptx())
  const first = await setup({ maxStoreBytes: 0 })
  const file = await first.upload(bytes)
  await first.post('/v2/library', { fileId: file.fileId, displayName: 'Retained source' })
  const opened = (await (await first.post('/v1/sessions', { fileId: file.fileId })).json()) as {
    sessionId: string
  }
  await first.request(`/v1/sessions/${opened.sessionId}`, { method: 'DELETE' })
  const artifactBytes = await new ArtifactStore(first.dataDir).totalBytes()
  await first.server.close()
  const pdf = Buffer.from('%PDF-1.7\n%%EOF\n')
  const second = await setup({
    dataDir: first.dataDir,
    maxStoreBytes: bytes.length + artifactBytes + pdf.length - 1,
  })
  const activeResponse = await second.post('/v1/sessions', { fileId: file.fileId })
  expect(activeResponse.status).toBe(201)
  const active = (await activeResponse.json()) as { sessionId: string }
  const blocked = await second.request('/v1/files', { method: 'POST', body: pdf })
  expect(blocked.status).toBe(507)
  expect((await second.request(`/v1/sessions/${active.sessionId}/layout/slides/0`)).status).toBe(
    200,
  )
  await second.request(`/v1/sessions/${active.sessionId}`, { method: 'DELETE' })
  const admitted = await second.request('/v1/files', { method: 'POST', body: pdf })
  expect(admitted.status).toBe(201)
  expect(await new ArtifactStore(first.dataDir).list()).toHaveLength(0)
  expect((await second.request(`/v1/files/${file.fileId}/content`)).status).toBe(200)
  expect(await (await second.request('/v2/library')).json()).toMatchObject({
    items: [{ fileId: file.fileId, displayName: 'Retained source' }],
  })
  const health = (await (await second.request('/v1/health')).json()) as any
  expect(health.artifacts.evicted).toBe(1)
  await second.server.close()
  const third = await setup({
    dataDir: first.dataDir,
    maxStoreBytes: bytes.length + artifactBytes + 1024 * 1024,
  })
  const rebuilt = await third.post('/v1/sessions', { fileId: file.fileId })
  expect(rebuilt.status).toBe(201)
  expect(await new ArtifactStore(first.dataDir).list()).toHaveLength(1)
})

it('a cold build reclaims another idle artifact through the shared write budget', async () => {
  const firstBytes = Buffer.from(await createBlankPptx())
  const zip = await JSZip.loadAsync(firstBytes)
  zip.file('unused-marker.txt', 'distinct source with the same slide model')
  const secondBytes = await zip.generateAsync({ type: 'nodebuffer' })
  const app = await setup({ maxStoreBytes: 0 })
  const first = await app.upload(firstBytes)
  const second = await app.upload(secondBytes)
  await app.post('/v2/library', { fileId: first.fileId })
  await app.post('/v2/library', { fileId: second.fileId })
  const warm = (await (await app.post('/v1/sessions', { fileId: first.fileId })).json()) as {
    sessionId: string
  }
  await app.request(`/v1/sessions/${warm.sessionId}`, { method: 'DELETE' })
  const cachedBytes = await new ArtifactStore(app.dataDir).totalBytes()
  await app.server.close()
  const limited = await setup({
    dataDir: app.dataDir,
    maxStoreBytes: firstBytes.length + secondBytes.length + cachedBytes + 64,
  })
  const cold = await limited.post('/v1/sessions', { fileId: second.fileId })
  expect(cold.status, await cold.clone().text()).toBe(201)
  const artifacts = await new ArtifactStore(app.dataDir).list()
  expect(artifacts).toHaveLength(1)
  expect(artifacts[0].manifest.identity.fileId).toBe(second.fileId)
  const health = (await (await limited.request('/v1/health')).json()) as any
  expect(health.artifacts.evicted).toBe(1)
  expect(health.artifacts.reservedBytes).toBe(0)
  expect((await limited.request(`/v1/files/${first.fileId}/content`)).status).toBe(200)
})

it('high-water GC reclaims idle cache while committed usage is still below the hard cap', async () => {
  const bytes = Buffer.from(await createBlankPptx())
  const first = await setup({ maxStoreBytes: 0 })
  const file = await first.upload(bytes)
  await first.post('/v2/library', { fileId: file.fileId })
  const session = (await (await first.post('/v1/sessions', { fileId: file.fileId })).json()) as {
    sessionId: string
  }
  await first.request(`/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
  const artifactBytes = await new ArtifactStore(first.dataDir).totalBytes()
  await first.server.close()
  const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(1000) + '\n%%EOF\n')
  const projected = bytes.length + artifactBytes + pdf.length
  const limit = Math.ceil(projected / 0.95)
  expect(projected).toBeLessThan(limit)
  expect(projected).toBeGreaterThan(limit * 0.9)
  const limited = await setup({ dataDir: first.dataDir, maxStoreBytes: limit })
  expect((await limited.request('/v1/files', { method: 'POST', body: pdf })).status).toBe(201)
  expect(await new ArtifactStore(first.dataDir).list()).toHaveLength(0)
  expect((await limited.request(`/v1/files/${file.fileId}/content`)).status).toBe(200)
  const health = (await (await limited.request('/v1/health')).json()) as any
  expect(health.artifacts.evicted).toBe(1)
  expect(health.storageBudget).toMatchObject({
    limitBytes: limit,
    reservedBytes: 0,
    highWaterBytes: Math.floor(limit * 0.9),
    lowWaterBytes: Math.floor(limit * 0.8),
  })
})
