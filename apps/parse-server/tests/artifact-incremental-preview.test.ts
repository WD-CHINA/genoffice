import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'
import { ArtifactWriter, type JsonValue } from '../src/artifact-store'
import { PreviewRegistry } from '../src/artifact-preview'

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

/** Three identical blank slides so a build can be paused after its first unit. */
async function multiSlidePptx(count: number, marker: string): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  zip.file('test-marker.txt', marker)
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  let ids = ''
  let relationships = ''
  let overrides = ''
  for (let index = 2; index <= count; index++) {
    ids += `<p:sldId id="${255 + index}" r:id="rId${index + 1}"/>`
    relationships += `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index}.xml"/>`
    overrides += `<Override PartName="/ppt/slides/slide${index}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    zip.file(`ppt/slides/slide${index}.xml`, slide)
    zip.file(`ppt/slides/_rels/slide${index}.xml.rels`, slideRels)
  }
  zip.file('ppt/presentation.xml', presentation.replace('</p:sldIdLst>', `${ids}</p:sldIdLst>`))
  zip.file(
    'ppt/_rels/presentation.xml.rels',
    rels.replace('</Relationships>', `${relationships}</Relationships>`),
  )
  zip.file('[Content_Types].xml', types.replace('</Types>', `${overrides}</Types>`))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(options: Partial<ParseServerOptions> = {}) {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'preview-parse-')))
  if (!options.dataDir) directories.push(dataDir)
  const server = await createParseServer({
    dataDir,
    token: 'secret',
    parserFingerprint: 'preview-test-build',
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
    const response = await request('/v1/files', {
      method: 'POST',
      body: Buffer.from(await multiSlidePptx(3, marker)),
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
      const status = (await response.json()) as { state: string; error?: unknown }
      if (status.state === 'ready') return status
      expect(status.state, JSON.stringify(status.error)).not.toBe('failed')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('async session did not become ready')
  }
  return { server, dataDir, request, upload, open, ready }
}

/** Pause immediately before the SECOND unit frame: exactly one committed unit exists. */
function pauseAfterFirstUnit() {
  const entered = gate()
  const blocked = gate()
  const original = ArtifactWriter.prototype.append
  let paused = false
  vi.spyOn(ArtifactWriter.prototype, 'append').mockImplementation(async function (
    this: ArtifactWriter,
    id: string,
    value: JsonValue | Uint8Array,
  ) {
    if (id === 'unit:1' && !paused) {
      paused = true
      entered.resolve()
      await blocked.promise
    }
    return original.call(this, id, value)
  })
  return { entered, blocked }
}

const document = (format = 'pptx', unitCount = 3) => ({
  type: 'document' as const,
  format: format as 'pptx' | 'docx',
  unitCount,
  document: { model: { format, unitCount, unitKind: 'slide' }, fonts: [] },
})
const unit = (index: number, produced: number) => ({
  type: 'unit' as const,
  index,
  unit: { index, slide: { nodes: [] } },
  unitsProduced: produced,
})

describe('PreviewRegistry', () => {
  it('only exposes strictly consecutive committed frames', () => {
    const registry = new PreviewRegistry()
    registry.report('key', document())
    expect(registry.get('key')?.previewable).toBe(false)
    registry.report('key', unit(0, 1))
    expect(registry.get('key')).toMatchObject({ unitsProduced: 1, cachedUntil: 1, complete: false })
    expect(registry.get('key')?.previewable).toBe(true)
    // Out-of-order, duplicated and inflated counters are ignored.
    registry.report('key', unit(2, 3))
    registry.report('key', unit(0, 1))
    registry.report('key', unit(1, 99))
    expect(registry.get('key')).toMatchObject({ unitsProduced: 1, cachedUntil: 1 })
    registry.report('key', unit(1, 2))
    expect(registry.get('key')).toMatchObject({ unitsProduced: 2, cachedUntil: 2 })
  })

  it('bounds retained units and bytes without stalling progress', () => {
    const limited = new PreviewRegistry({ maxUnits: 2 })
    limited.report('key', document())
    limited.report('key', unit(0, 1))
    limited.report('key', unit(1, 2))
    limited.report('key', unit(2, 3))
    expect(limited.get('key')).toMatchObject({ unitsProduced: 3, cachedUntil: 2 })
    expect(limited.get('key')?.units).toHaveLength(2)
    const tiny = new PreviewRegistry({ maxBytes: 4 })
    tiny.report('tiny', document())
    tiny.report('tiny', unit(0, 1))
    expect(tiny.get('tiny')).toMatchObject({ unitsProduced: 1, cachedUntil: 0, previewable: false })
  })

  it('drops failed builds immediately and keeps done distinct from ready', () => {
    const registry = new PreviewRegistry()
    registry.report('key', document())
    registry.report('key', unit(0, 1))
    registry.report('key', { type: 'done' })
    expect(registry.get('key')).toMatchObject({ complete: true, previewable: true })
    registry.report('key', { type: 'failed' })
    expect(registry.get('key')).toBeUndefined()
    expect(registry.stats()).toMatchObject({ keys: 0, completed: 1, failed: 1 })
  })

  it('prunes expired and excess keys', () => {
    let now = 1_000
    const registry = new PreviewRegistry({ ttlMs: 10, maxKeys: 2, now: () => now })
    registry.report('a', document())
    registry.report('a', unit(0, 1))
    now = 1_005
    registry.report('b', document())
    registry.report('b', unit(0, 1))
    now = 1_006
    registry.report('c', document())
    registry.report('c', unit(0, 1))
    expect(registry.get('a')).toBeUndefined()
    expect(registry.stats().keys).toBe(2)
    now = 1_020
    expect(registry.stats().keys).toBe(0)
  })

  it('rejects malformed documents, invalid options and never throws into a build', () => {
    expect(() => new PreviewRegistry({ maxUnits: 0 })).toThrow(/invalid preview/)
    const registry = new PreviewRegistry()
    registry.report('bad', {
      type: 'document',
      format: 'pptx',
      unitCount: 3,
      document: { fonts: [] },
    })
    registry.report('bad2', {
      type: 'document',
      format: 'pptx',
      unitCount: -1,
      document: { model: { format: 'pptx' }, fonts: [] },
    })
    expect(registry.get('bad')).toBeUndefined()
    expect(registry.get('bad2')).toBeUndefined()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() =>
      registry.report('cyclic', { type: 'unit', index: 0, unit: cyclic, unitsProduced: 1 }),
    ).not.toThrow()
    expect(() =>
      registry.report('key', { type: 'unit', index: 0, unit: {}, unitsProduced: 1 }),
    ).not.toThrow()
  })

  it('returns a read-only copy so a preview consumer cannot mutate committed records', () => {
    const registry = new PreviewRegistry()
    registry.report('key', document())
    registry.report('key', unit(0, 1))
    const snapshot = registry.get('key')!
    ;(snapshot.units as unknown[]).push({ injected: true })
    ;(snapshot.units[0] as { index: number }).index = 99
    expect(registry.get('key')?.units).toHaveLength(1)
    expect((registry.get('key')?.units[0] as { index: number }).index).toBe(0)
  })
})

describe('v1 incremental first frame', () => {
  it('exposes previewable building state, never ready, and keeps offline bundles closed', async () => {
    const harness = await setup()
    const fileId = await harness.upload()
    const paused = pauseAfterFirstUnit()
    const created = await harness.open(fileId)
    expect(created.status).toBe(202)
    const { sessionId } = (await created.json()) as { sessionId: string }
    try {
      await paused.entered.promise
      const status = (await (await harness.request(`/v1/sessions/${sessionId}`)).json()) as Record<
        string,
        unknown
      >
      expect(status).toMatchObject({
        state: 'building',
        previewable: true,
        complete: false,
        availableUnits: { from: 0, to: 1 },
      })
      expect(status.progress).toMatchObject({ unitsProduced: 1, unitCount: 3 })
      expect(status.state).not.toBe('ready')
      expect((await harness.request(`/v1/sessions/${sessionId}/bundle`)).status).toBe(409)
      const capabilities = (await (await harness.request('/v1/capabilities')).json()) as {
        features: { incrementalPreview?: boolean }
      }
      expect(capabilities.features.incrementalPreview).toBe(true)
      const health = (await (await harness.request('/v1/health')).json()) as {
        maintenance: { incrementalPreview: { cachedUnits: number } }
      }
      expect(health.maintenance.incrementalPreview.cachedUnits).toBeGreaterThan(0)
    } finally {
      paused.blocked.resolve()
    }
    await harness.ready(sessionId)
  })

  it('serves document, available units and explicit pending ranges while building', async () => {
    const harness = await setup()
    const fileId = await harness.upload('pending')
    const paused = pauseAfterFirstUnit()
    const created = await harness.open(fileId)
    const { sessionId } = (await created.json()) as { sessionId: string }
    try {
      await paused.entered.promise
      const doc = (await (
        await harness.request(`/v1/sessions/${sessionId}/document`)
      ).json()) as Record<string, unknown>
      expect(doc).toMatchObject({
        state: 'building',
        complete: false,
        unitCount: 3,
        unitsProduced: 1,
      })
      expect((doc.model as { unitCount: number }).unitCount).toBe(3)
      expect(doc.layout).toBeDefined()

      const listing = (await (
        await harness.request(`/v1/sessions/${sessionId}/units`)
      ).json()) as Record<string, unknown>
      expect(listing).toMatchObject({
        state: 'building',
        complete: false,
        unitsProduced: 1,
        unitCount: 3,
        availableUnits: { from: 0, to: 1 },
      })
      expect(listing.items).toHaveLength(1)
      expect(listing.pending).toMatchObject({
        from: 1,
        to: 3,
        code: 'unit_pending',
        retryAfterMs: 500,
      })
      const beyond = (await (
        await harness.request(`/v1/sessions/${sessionId}/units?cursor=1`)
      ).json()) as { items: unknown[]; pending: { from: number } }
      expect(beyond.items).toHaveLength(0)
      expect(beyond.pending.from).toBe(1)
      expect((await harness.request(`/v1/sessions/${sessionId}/units?cursor=99`)).status).toBe(400)
    } finally {
      paused.blocked.resolve()
    }
    await harness.ready(sessionId)
  })

  it('returns the committed unit, 202 pending for uncommitted ones, and never a partial document', async () => {
    const harness = await setup()
    const fileId = await harness.upload('unit')
    const paused = pauseAfterFirstUnit()
    const created = await harness.open(fileId)
    const { sessionId } = (await created.json()) as { sessionId: string }
    let previewUnit: unknown
    try {
      await paused.entered.promise
      const first = await harness.request(`/v1/sessions/${sessionId}/units/0?representation=model`)
      expect(first.status).toBe(200)
      previewUnit = await first.json()
      expect(previewUnit).toBeTruthy()
      const pending = await harness.request(
        `/v1/sessions/${sessionId}/units/1?representation=model`,
      )
      expect(pending.status).toBe(202)
      expect(pending.headers.get('Retry-After')).toBe('1')
      expect(await pending.json()).toMatchObject({
        state: 'pending',
        code: 'unit_pending',
        complete: false,
        availableUnits: { from: 0, to: 1 },
        retryAfterMs: 500,
      })
      expect(
        (await harness.request(`/v1/sessions/${sessionId}/units/3?representation=model`)).status,
      ).toBe(400)
      expect(
        (await harness.request(`/v1/sessions/${sessionId}/units/not-a-unit?representation=model`))
          .status,
      ).toBe(400)
    } finally {
      paused.blocked.resolve()
    }
    await harness.ready(sessionId)
    const finalUnit = await (
      await harness.request(`/v1/sessions/${sessionId}/units/0?representation=model`)
    ).json()
    expect(finalUnit).toEqual(previewUnit)
    const listing = (await (await harness.request(`/v1/sessions/${sessionId}/units`)).json()) as {
      items: unknown[]
      complete?: boolean
      pending?: unknown
    }
    expect(listing.items).toHaveLength(3)
    expect(listing.complete).toBeUndefined()
    expect(listing.pending).toBeUndefined()
  })

  it('drops the preview on build failure and never reports a partial document as ready', async () => {
    const harness = await setup()
    const fileId = await harness.upload('failing')
    const original = ArtifactWriter.prototype.append
    vi.spyOn(ArtifactWriter.prototype, 'append').mockImplementation(async function (
      this: ArtifactWriter,
      id: string,
      value: JsonValue | Uint8Array,
    ) {
      if (id === 'unit:1') throw new Error('injected mid-build failure')
      return original.call(this, id, value)
    })
    const created = await harness.open(fileId)
    const { sessionId } = (await created.json()) as { sessionId: string }
    const deadline = Date.now() + 10_000
    let status: Record<string, unknown> = {}
    while (Date.now() < deadline) {
      status = (await (await harness.request(`/v1/sessions/${sessionId}`)).json()) as Record<
        string,
        unknown
      >
      if (status.state === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(status.state).toBe('failed')
    expect(status.previewable).toBeUndefined()
    expect(status.complete).toBeUndefined()
    expect(
      (await harness.request(`/v1/sessions/${sessionId}/units/0?representation=model`)).status,
    ).toBe(409)
    expect((await harness.request(`/v1/sessions/${sessionId}/document`)).status).toBe(409)
  })

  it('a cached hit has no previewable state and configuration is validated', async () => {
    const harness = await setup()
    const fileId = await harness.upload('cached')
    const created = await harness.open(fileId)
    const { sessionId } = (await created.json()) as { sessionId: string }
    expect(created.status).toBe(202)
    await harness.ready(sessionId)
    const hit = await harness.open(fileId)
    expect(hit.status).toBe(201)
    const hitBody = (await hit.json()) as { state: string; previewable?: boolean }
    expect(hitBody.state).toBe('ready')
    expect(hitBody.previewable).toBeUndefined()

    const dir = await mkdtemp(join(tmpdir(), 'preview-invalid-'))
    directories.push(dir)
    await expect(createParseServer({ dataDir: dir, previewMaxUnits: 0 })).rejects.toThrow(
      /invalid previewMaxUnits/,
    )
    await expect(createParseServer({ dataDir: dir, previewTtlMs: 1 })).rejects.toThrow(
      /invalid previewTtlMs/,
    )
  })
})
