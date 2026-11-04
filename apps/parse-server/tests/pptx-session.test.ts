import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'

interface Harness {
  server: ParseServer
  dir: string
  cleanup(): Promise<void>
}

const harnesses: Harness[] = []

async function start(options: Partial<ParseServerOptions> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'parse-server-pptx-'))
  const server = await createParseServer({ dataDir: dir, ...options })
  const harness: Harness = {
    server,
    dir,
    async cleanup() {
      await server.close().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    },
  }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.cleanup()
})

async function upload(url: string, body: Buffer): Promise<{ fileId: string }> {
  const response = await fetch(`${url}/v1/files`, { method: 'POST', body })
  expect(response.status).toBe(201)
  return (await response.json()) as { fileId: string }
}

async function openSession(url: string, fileId: string): Promise<Response> {
  return fetch(`${url}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
}

describe('pptx sessions', () => {
  it('opens a deck and serves slide units one at a time', async () => {
    const { server } = await start()
    const file = await upload(server.url, Buffer.from(await createBlankPptx()))

    const opened = await openSession(server.url, file.fileId)
    expect(opened.status).toBe(201)
    const body = (await opened.json()) as {
      sessionId: string
      state: string
      model: { format: string; unitKind: string; unitCount: number; stagesPending: string[] }
    }
    expect(body.state).toBe('ready')
    expect(body.model.format).toBe('pptx')
    expect(body.model.unitKind).toBe('slide')
    expect(body.model.unitCount).toBe(1)
    expect(body.model.stagesPending).toContain('measure')

    const units = await fetch(`${server.url}/v1/sessions/${body.sessionId}/units`)
    expect(units.status).toBe(200)
    const unitList = (await units.json()) as { items: Array<{ id: string; kind: string }> }
    expect(unitList.items).toHaveLength(1)
    expect(unitList.items[0]).toMatchObject({ id: '0', kind: 'slide' })

    const unit = await fetch(`${server.url}/v1/sessions/${body.sessionId}/units/0`)
    expect(unit.status).toBe(200)
    const payload = (await unit.json()) as {
      slide: { widthPx: number; heightPx: number; nodes: unknown[] }
      playback: { transition: unknown; keys: unknown[] }
    }
    expect(payload.slide.widthPx).toBeGreaterThan(0)
    expect(payload.slide.heightPx).toBeGreaterThan(0)
    expect(Array.isArray(payload.slide.nodes)).toBe(true)
    expect(Array.isArray(payload.playback.keys)).toBe(true)

    expect(
      (await fetch(`${server.url}/v1/sessions/${body.sessionId}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect((await fetch(`${server.url}/v1/sessions/${body.sessionId}`)).status).toBe(404)
  })

  it('opens a real multi-slide fixture and paginates units', async () => {
    const { server } = await start()
    const fixture = await readFile(
      new URL(
        '../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
        import.meta.url,
      ),
    )
    const file = await upload(server.url, fixture)
    const opened = (await (await openSession(server.url, file.fileId)).json()) as {
      sessionId: string
      model: { unitCount: number }
    }
    expect(opened.model.unitCount).toBeGreaterThan(1)

    const first = (await (
      await fetch(`${server.url}/v1/sessions/${opened.sessionId}/units?limit=2`)
    ).json()) as { items: unknown[]; next?: string }
    expect(first.items).toHaveLength(2)
    expect(first.next).toBe('2')

    const second = (await (
      await fetch(
        `${server.url}/v1/sessions/${opened.sessionId}/units?cursor=${first.next}&limit=2`,
      )
    ).json()) as { items: unknown[] }
    expect(second.items.length).toBeGreaterThan(0)
  })

  it('refuses a PDF session and a deck over the parse limit', async () => {
    const { server } = await start({ limits: { maxParseBytes: 1024 } })
    const pdf = await upload(server.url, Buffer.from('%PDF-1.7\n%%EOF\n'))
    expect((await openSession(server.url, pdf.fileId)).status).toBe(415)

    const deck = await upload(server.url, Buffer.from(await createBlankPptx()))
    expect((await openSession(server.url, deck.fileId)).status).toBe(413)
  })
})

function partUrls(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/\/v1\/files\/[^/]+\/parts\//.test(value)) out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) partUrls(item, out)
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) partUrls(item, out)
  }
  return out
}

describe('pptx media parts', () => {
  it('strips media from the parser archive and serves it by part URL', async () => {
    const { server } = await start()
    const fixture = await readFile(
      new URL(
        '../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
        import.meta.url,
      ),
    )
    const file = await upload(server.url, fixture)
    const opened = (await (await openSession(server.url, file.fileId)).json()) as {
      sessionId: string
    }
    const unit = (await (
      await fetch(`${server.url}/v1/sessions/${opened.sessionId}/units/2`)
    ).json()) as { slide: unknown }
    const urls = [...new Set(partUrls(unit.slide))]
    expect(urls.length).toBeGreaterThan(0)
    const part = await fetch(urls[0])
    expect(part.status).toBe(200)
    expect(part.headers.get('content-type')).toBe('image/png')
    expect((await part.arrayBuffer()).byteLength).toBeGreaterThan(0)
    expect((await fetch(`${server.url}/v1/files/${file.fileId}/parts/nope.bin`)).status).toBe(404)
  })
})

describe('pptx text width feedback', () => {
  it('returns measurements, accepts browser widths and rebuilds slides', async () => {
    const { server } = await start()
    const fixture = await readFile(
      new URL(
        '../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
        import.meta.url,
      ),
    )
    const file = await upload(server.url, fixture)
    const opened = (await (await openSession(server.url, file.fileId)).json()) as {
      sessionId: string
    }
    const first = (await (
      await fetch(`${server.url}/v1/sessions/${opened.sessionId}/units/0`)
    ).json()) as {
      measurements: Array<{ key: string; text: string }>
    }
    expect(first.measurements.length).toBeGreaterThan(0)
    const widths = first.measurements.map((item) => ({ key: item.key, width: 42.5 }))
    const accepted = await fetch(`${server.url}/v1/sessions/${opened.sessionId}/text-widths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ widths }),
    })
    expect(accepted.status).toBe(200)
    const body = (await accepted.json()) as { measurements: unknown[] }
    expect(body.measurements).toEqual([])

    const rebuilt = (await (
      await fetch(`${server.url}/v1/sessions/${opened.sessionId}/units/0`)
    ).json()) as { measurements: unknown[] }
    expect(rebuilt.measurements).toEqual([])
  })
})

describe('pptx media auth', () => {
  it('embeds the bearer token in part URLs so <img> requests work', async () => {
    const { server } = await start({ token: 'secret' })
    const fixture = await readFile(
      new URL(
        '../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
        import.meta.url,
      ),
    )
    const uploadResponse = await fetch(`${server.url}/v1/files`, {
      method: 'POST',
      body: fixture,
      headers: { Authorization: 'Bearer secret' },
    })
    const file = (await uploadResponse.json()) as { fileId: string }
    const openResponse = await fetch(`${server.url}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ fileId: file.fileId }),
    })
    const opened = (await openResponse.json()) as { sessionId: string }
    const unit = (await (
      await fetch(`${server.url}/v1/sessions/${opened.sessionId}/units/2`, {
        headers: { Authorization: 'Bearer secret' },
      })
    ).json()) as { slide: unknown }
    const url = partUrls(unit.slide)[0]
    expect(url).toContain('exp=')
    expect(url).toContain('sig=')
    expect((await fetch(url)).status).toBe(200)
    expect((await fetch(url.replace(/\?.*$/, ''))).status).toBe(401)
  })
})

describe('pptx worker isolation', () => {
  it('caps concurrent sessions', async () => {
    const { server } = await start({ maxSessions: 1 })
    const file = await upload(server.url, Buffer.from(await createBlankPptx()))
    const first = await openSession(server.url, file.fileId)
    expect(first.status).toBe(201)
    const second = await openSession(server.url, file.fileId)
    expect(second.status).toBe(429)
    expect(((await second.json()) as { code: string }).code).toBe('too_many_sessions')
    const opened = (await first.json()) as { sessionId: string }
    expect(
      (await fetch(`${server.url}/v1/sessions/${opened.sessionId}`, { method: 'DELETE' })).status,
    ).toBe(204)
  })

  it('kills a timed-out parse and keeps the server healthy', async () => {
    const { server } = await start({ parseTimeoutMs: 1 })
    const file = await upload(server.url, Buffer.from(await createBlankPptx()))
    const opened = await openSession(server.url, file.fileId)
    expect(opened.status).toBe(504)
    expect(((await opened.json()) as { code: string }).code).toBe('parse_timeout')
    expect((await fetch(`${server.url}/v1/health`)).status).toBe(200)
  })
})

describe('pptx session persistence', () => {
  it('restores session metadata and lazily reopens the worker after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parse-server-restart-'))
    const first = await createParseServer({ dataDir: dir })
    try {
      const file = await upload(first.url, Buffer.from(await createBlankPptx()))
      const opened = (await (await openSession(first.url, file.fileId)).json()) as {
        sessionId: string
      }
      await first.close()

      const second = await createParseServer({ dataDir: dir })
      try {
        const state = await fetch(`${second.url}/v1/sessions/${opened.sessionId}`)
        expect(state.status).toBe(200)
        const body = (await state.json()) as { model: { unitCount: number } }
        expect(body.model.unitCount).toBe(1)

        const units = await fetch(`${second.url}/v1/sessions/${opened.sessionId}/units`)
        expect(units.status).toBe(200)

        const unit = await fetch(`${second.url}/v1/sessions/${opened.sessionId}/units/0`)
        expect(unit.status).toBe(200)
        const payload = (await unit.json()) as { slide: { widthPx: number } }
        expect(payload.slide.widthPx).toBeGreaterThan(0)
      } finally {
        await second.close()
      }
    } finally {
      await first.close().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('content GC protection', () => {
  it('keeps content referenced by a session and refuses to delete it', async () => {
    const { server } = await start({ contentTtlMs: 1, gcIntervalMs: 60_000 })
    const file = await upload(server.url, Buffer.from(await createBlankPptx()))
    const opened = (await (await openSession(server.url, file.fileId)).json()) as {
      sessionId: string
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
    await server.gc()
    expect((await fetch(`${server.url}/v1/files/${file.fileId}`)).status).toBe(200)
    expect(
      (await fetch(`${server.url}/v1/files/${file.fileId}`, { method: 'DELETE' })).status,
    ).toBe(409)
    expect(
      (await fetch(`${server.url}/v1/sessions/${opened.sessionId}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect(
      (await fetch(`${server.url}/v1/files/${file.fileId}`, { method: 'DELETE' })).status,
    ).toBe(204)
  })
})
