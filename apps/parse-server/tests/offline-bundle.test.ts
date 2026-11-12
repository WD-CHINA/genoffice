import { serverRoot } from './helpers/paths'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { afterEach, expect, it, vi } from 'vitest'
import { createBlankPptx } from '@genoffice/pptx-engine'
import type { OfflineBundleManifest } from '@genoffice/parse-contract'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import { PptxSession } from '../src/pptx'
import { externalMedia, validBundlePath } from '../src/offline-bundle'
import { MODEL_SCHEMA_VERSION } from '../src/artifact-session'

const servers: ParseServer[] = []
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  // Capture ownership before awaiting, including a possible teardown timeout.
  const ownedServers = servers.splice(0),
    ownedDirectories = directories.splice(0)
  await Promise.all(ownedServers.map((server) => server.close()))
  await Promise.all(ownedDirectories.map((dir) => rm(dir, { recursive: true, force: true })))
})
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function setup(existing?: string, options: Partial<ParseServerOptions> = {}) {
  const dir = existing ?? (await mkdtemp(join(tmpdir(), 'offline-bundle-')))
  if (!existing) directories.push(dir)
  const server = await createParseServer({
    dataDir: dir,
    token: 'secret',
    parserFingerprint: 'bundle-test-build',
    ...options,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) =>
    fetch(server.url + path, {
      ...init,
      headers: { Authorization: 'Bearer secret', ...init?.headers },
    })
  const upload = async (body: Buffer) => {
    const response = await request('/v1/files', { method: 'POST', body })
    expect(response.status).toBe(201)
    return ((await response.json()) as { fileId: string }).fileId
  }
  const open = async (fileId: string) => {
    const response = await request('/v1/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId }),
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return ((await response.json()) as { sessionId: string }).sessionId
  }
  const manifest = async (id: string) => {
    const response = await request(`/v2/sessions/${id}/bundle`)
    expect(response.status, await response.clone().text()).toBe(200)
    return (await response.json()) as OfflineBundleManifest
  }
  return { server, dir, request, upload, open, manifest }
}

it('serves exact hashed bundle bytes, complete stripped-media inventory and authenticated resume semantics', async () => {
  const app = await setup()
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const font = await readFile(join(serverRoot, '../../packages/ui/src/fonts/Carlito-Regular.ttf'))
  zip.file(
    'ppt/presentation.xml',
    (await zip.file('ppt/presentation.xml')!.async('string')).replace(
      '</p:presentation>',
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Carlito"/><p:regular r:id="rIdBundleFont"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    ),
  )
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    (await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')).replace(
      '</Relationships>',
      '<Relationship Id="rIdBundleFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/bundle.fntdata"/></Relationships>',
    ),
  )
  zip.file('ppt/fonts/bundle.fntdata', font)
  const media = Buffer.from('unused streamed media '.repeat(1000))
  zip.file('ppt/media/stored.bin', media, { compression: 'STORE' })
  zip.file('ppt/media/deflated.bin', media, { compression: 'DEFLATE' })
  zip.file('ppt/media/音 频.bin', Buffer.from('unicode path'), { compression: 'STORE' })
  zip.file('ppt/media/empty.bin', Buffer.alloc(0))
  const fileId = await app.upload(await zip.generateAsync({ type: 'nodebuffer' }))
  const id = await app.open(fileId)
  const manifest = await app.manifest(id)
  for (const path of ['document.json', 'units/0.json'])
    expect((await app.request(`/v2/sessions/${id}/bundle/resources/${path}`)).status).toBe(404)
  expect(manifest).toMatchObject({
    fileId,
    format: 'pptx',
    bundleSchemaVersion: 1,
    modelSchemaVersion: MODEL_SCHEMA_VERSION,
    parserFingerprint: 'bundle-test-build',
    inventory: 'ppt-media-v1',
  })
  expect(manifest.fonts).toEqual([
    expect.objectContaining({ id: 'embed:0', resourcePath: 'fonts/font-0.sfnt' }),
  ])
  expect(manifest.resources.find((resource) => resource.path === 'fonts/font-0.sfnt')?.sha256).toBe(
    sha(font),
  )
  expect(manifest.artifactKey).toMatch(/^[a-f0-9]{64}$/)
  expect(manifest.resources.map((resource) => resource.path)).toEqual(
    expect.arrayContaining([
      'layout.json',
      'layout/0.json',
      'parts/ppt/media/stored.bin',
      'parts/ppt/media/deflated.bin',
      'parts/ppt/media/音 频.bin',
      'parts/ppt/media/empty.bin',
    ]),
  )
  expect(manifest.totalBytes).toBe(
    manifest.resources.reduce((sum, resource) => sum + resource.size, 0),
  )
  for (const resource of manifest.resources) {
    const response = await app.request(resource.href!)
    expect(response.status).toBe(200)
    expect(response.headers.get('etag')).toBe(`"${resource.sha256}"`)
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes.length).toBe(resource.size)
    expect(sha(bytes)).toBe(resource.sha256)
    if (resource.path.endsWith('.json'))
      expect(bytes.toString()).not.toContain('http://artifact.invalid')
    expect((await fetch(app.server.url + resource.href!)).status).toBe(401)
  }
  const stored = manifest.resources.find((resource) => resource.path.endsWith('/stored.bin'))!
  const partial = await app.request(stored.href!, {
    headers: { Range: 'bytes=3-8', 'If-Range': `"${stored.sha256}"` },
  })
  expect(partial.status).toBe(206)
  expect(Buffer.from(await partial.arrayBuffer())).toEqual(media.subarray(3, 9))
  const stale = await app.request(stored.href!, {
    headers: { Range: 'bytes=3-8', 'If-Range': '"outdated"' },
  })
  expect(stale.status).toBe(200)
  expect(sha(Buffer.from(await stale.arrayBuffer()))).toBe(stored.sha256)
  const deflated = manifest.resources.find((resource) => resource.path.endsWith('/deflated.bin'))!
  const full = await app.request(deflated.href!, { headers: { Range: 'bytes=3-8' } })
  expect(full.status).toBe(200)
  expect(sha(Buffer.from(await full.arrayBuffer()))).toBe(deflated.sha256)
  expect(
    (await app.request(`/v2/sessions/${id}/bundle/resources/parts/ppt/media/missing.bin`)).status,
  ).toBe(404)
  expect((await app.request(`/v2/sessions/${id}/bundle/resources/parts/%E0%A4%A`)).status).toBe(400)
  const head = await app.request(stored.href!, { method: 'HEAD' })
  expect(head.headers.get('content-length')).toBe(String(stored.size))
  expect((await head.arrayBuffer()).byteLength).toBe(0)
  const capabilities = (await (await app.request('/v2/capabilities')).json()) as any
  expect(capabilities.features.offlineBundles).toBe(true)
})

it('retains bundle identity and resource digests across a restart without launching another parser', async () => {
  const first = await setup()
  const parse = vi.spyOn(PptxSession, 'open')
  const fileId = await first.upload(Buffer.from(await createBlankPptx()))
  const id = await first.open(fileId)
  const before = await first.manifest(id)
  await first.request(`/v1/sessions/${id}`, { method: 'DELETE' })
  await first.server.close()
  servers.splice(servers.indexOf(first.server), 1)
  parse.mockClear()
  const second = await setup(first.dir)
  const restored = await second.manifest(await second.open(fileId))
  const stable = (manifest: OfflineBundleManifest) => ({
    ...manifest,
    resources: manifest.resources.map(({ href: _href, ...resource }) => resource),
  })
  expect(stable(restored)).toEqual(stable(before))
  expect(parse).not.toHaveBeenCalled()
})

it('rejects bad media CRC during construction and never publishes a falsely complete bundle', async () => {
  const app = await setup()
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const body = Buffer.from('unique-bundle-crc-payload')
  zip.file('ppt/media/bad.bin', body, { compression: 'STORE' })
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const offset = bytes.indexOf(body)
  expect(offset).toBeGreaterThan(0)
  bytes[offset] ^= 1
  const fileId = await app.upload(bytes)
  const id = await app.open(fileId)
  const before = (await (await app.request('/v1/health')).json()) as any
  expect(before.artifacts.buildsStarted).toBe(1)
  expect(before.artifacts.sourceParsesStarted).toBe(1)
  const response = await app.request(`/v2/sessions/${id}/bundle`)
  expect(response.status).toBe(422)
  expect(await response.text()).toContain('CRC mismatch')
  expect((await app.request(`/v2/sessions/${id}/units/0`)).status).toBe(200)
  expect(await readdir(join(app.dir, 'staging'))).toEqual([])
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.activeWorkers).toBe(0)
  expect(health.artifacts.activeBuilds).toBe(0)
})

it('limits bundle paths and records external media through the typed media contract', () => {
  for (const path of ['../x', '/x', 'parts//x', 'parts/./x', 'parts/../x', 'parts\\x'])
    expect(validBundlePath(path)).toBe(false)
  expect(
    externalMedia({
      slide: 'https://text-is-not-a-media-resource',
      playback: [],
      size: { cx: 1, cy: 1 },
      media: [
        ['one', 'https://example.test/image.png'],
        ['two', '/v1/files/file/parts/ppt/media/a.png'],
      ],
      mediaRefs: [{ sourceId: 'audio', kind: 'audio', url: 'https://example.test/audio.mp3' }],
    }),
  ).toEqual(['https://example.test/image.png', 'https://example.test/audio.mp3'])
})

it('queues lazy bundle construction separately and keeps cached previews readable when the queue is full', async () => {
  const app = await setup(undefined, { maxParseJobs: 1, maxQueuedParseJobs: 0 })
  const bytes = Buffer.from(await createBlankPptx())
  const warm = await app.open(await app.upload(bytes))
  const zip = await JSZip.loadAsync(bytes)
  zip.file('different-source.txt', 'cold source')
  const cold = await app.upload(await zip.generateAsync({ type: 'nodebuffer' }))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = PptxSession.open.bind(PptxSession)
  vi.spyOn(PptxSession, 'open').mockImplementation(async (input) => {
    entered()
    await gate
    return original(input)
  })
  const building = app.open(cold)
  try {
    await started
    const blocked = await app.request(`/v2/sessions/${warm}/bundle`)
    expect(blocked.status).toBe(429)
    expect((await app.request(`/v2/sessions/${warm}/units/0`)).status).toBe(200)
  } finally {
    release()
    await building
  }
  expect((await app.manifest(warm)).artifactKey).toMatch(/^[a-f0-9]{64}$/)
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.artifacts.sourceParsesStarted).toBe(2)
})

it('retains a shared lazy build after its client cancels and closes the viewing session', async () => {
  const app = await setup(undefined, { maxParseJobs: 1, maxQueuedParseJobs: 1 })
  const bytes = Buffer.from(await createBlankPptx())
  const fileId = await app.upload(bytes)
  const warm = await app.open(fileId)
  const zip = await JSZip.loadAsync(bytes)
  zip.file('different-source.txt', 'cold source')
  const cold = await app.upload(await zip.generateAsync({ type: 'nodebuffer' }))
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const original = PptxSession.open.bind(PptxSession)
  vi.spyOn(PptxSession, 'open').mockImplementation(async (input) => {
    entered()
    await gate
    return original(input)
  })
  const building = app.open(cold)
  const controller = new AbortController()
  try {
    await started
    const requested = app.request(`/v2/sessions/${warm}/bundle`, { signal: controller.signal })
    const aborted = expect(requested).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(
      async () => {
        const health = (await (await app.request('/v1/health')).json()) as any
        expect(health.parseQueue.queued).toBe(1)
      },
      { timeout: 5000 },
    )
    controller.abort()
    await aborted
    expect((await app.request(`/v2/sessions/${warm}`, { method: 'DELETE' })).status).toBe(204)
  } finally {
    controller.abort()
    release()
    await building
  }
  await vi.waitFor(
    async () => {
      const health = (await (await app.request('/v1/health')).json()) as any
      expect(health.activeWorkers).toBe(0)
    },
    { timeout: 5000 },
  )
  expect((await app.manifest(await app.open(fileId))).artifactKey).toMatch(/^[a-f0-9]{64}$/)
  const health = (await (await app.request('/v1/health')).json()) as any
  expect(health.artifacts.sourceParsesStarted).toBe(2)
})

it.each(['image', 'font', 'table'])(
  'exports verified DOCX %s context, chunks, styles and inventory for offline replay',
  async (fixture) => {
    const h = await setup()
    const zip = await JSZip.loadAsync(
      await readFile(new URL(`./fixtures/docx/${fixture}.docx`, import.meta.url)),
    )
    zip.file('word/embeddings/unused.bin', Buffer.from('offline-inventory'))
    const fileId = await h.upload(await zip.generateAsync({ type: 'nodebuffer' }))
    const sessionId = await h.open(fileId)
    const response = await h.request(`/v2/sessions/${sessionId}/bundle`)
    expect(response.status, await response.clone().text()).toBe(200)
    const manifest = (await response.json()) as OfflineBundleManifest
    expect(manifest.format).toBe('docx')
    for (const path of ['layout.json', 'layout/0.json'])
      expect((await h.request(`/v2/sessions/${sessionId}/bundle/resources/${path}`)).status).toBe(
        404,
      )
    expect(manifest.inventory).toBe('docx-media-v1')
    expect(manifest.resources.map((resource) => resource.path)).toEqual(
      expect.arrayContaining([
        'document.json',
        'styles.json',
        'units/0.json',
        'parts/word/embeddings/unused.bin',
      ]),
    )
    let total = 0
    for (const resource of manifest.resources) {
      const read = await h.request(resource.href!)
      expect(read.status).toBe(200)
      const bytes = Buffer.from(await read.arrayBuffer())
      expect(bytes.length).toBe(resource.size)
      expect(sha(bytes)).toBe(resource.sha256)
      total += resource.size
      if (resource.path === 'document.json') {
        expect(JSON.parse(bytes.toString()).model.format).toBe('docx')
        expect(bytes.toString()).not.toContain('?exp=')
      }
    }
    expect(total).toBe(manifest.totalBytes)
    const reopened = await h.open(fileId)
    const warm = (await (
      await h.request(`/v2/sessions/${reopened}/bundle`)
    ).json()) as OfflineBundleManifest
    expect(warm.artifactKey).toBe(manifest.artifactKey)
  },
  30_000,
)
