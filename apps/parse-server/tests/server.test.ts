import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { createParseServer, type ParseServer, type ParseServerOptions } from '../src/server'

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n')

interface Harness {
  server: ParseServer
  dir: string
  cleanup(): Promise<void>
}

const harnesses: Harness[] = []

async function start(options: Partial<ParseServerOptions> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'parse-server-test-'))
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

async function upload(url: string, body: Buffer, init: RequestInit = {}): Promise<Response> {
  return fetch(`${url}/v1/files`, { method: 'POST', body, ...init })
}

async function zipWith(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

describe('parse-server', () => {
  it('advertises PPTX/PDF/DOCX capabilities', async () => {
    const { server } = await start()
    const response = await fetch(`${server.url}/v1/capabilities`)
    expect(response.status).toBe(200)
    const caps = (await response.json()) as { formats: string[]; contractVersion: number }
    expect(caps.contractVersion).toBe(1)
    expect(caps.formats).toEqual(['pptx', 'pdf', 'docx'])
  })

  it('opens a DOCX block-chunk session', async () => {
    const { server } = await start()
    const bytes = await readFile(join(process.cwd(), 'tests', 'fixtures', 'docx', 'table.docx'))
    const uploaded = await upload(server.url, bytes)
    expect(uploaded.status).toBe(201)
    const file = (await uploaded.json()) as { fileId: string; format: string }
    expect(file.format).toBe('docx')
    const opened = await fetch(`${server.url}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: file.fileId }),
    })
    expect(opened.status).toBe(201)
    const session = (await opened.json()) as {
      sessionId: string
      model: { format: string; unitKind: string; unitCount: number }
    }
    expect(session.model.format).toBe('docx')
    expect(session.model.unitKind).toBe('block-chunk')
    expect(session.model.unitCount).toBeGreaterThan(0)
    const units = await fetch(`${server.url}/v1/sessions/${session.sessionId}/units`)
    expect(units.status).toBe(200)
    const listing = (await units.json()) as { items: Array<{ kind: string }> }
    expect(listing.items.every((item) => item.kind === 'block-chunk')).toBe(true)
    const unit = await fetch(`${server.url}/v1/sessions/${session.sessionId}/units/0`)
    expect(unit.status).toBe(200)
    const chunk = (await unit.json()) as { blocks: unknown[] }
    expect(chunk.blocks.length).toBeGreaterThan(0)
    expect(
      (await fetch(`${server.url}/v1/sessions/${session.sessionId}`, { method: 'DELETE' })).status,
    ).toBe(204)
  })

  it('serves DOCX embedded fonts', async () => {
    const { server } = await start()
    const bytes = await readFile(join(process.cwd(), 'tests', 'fixtures', 'docx', 'font.docx'))
    const uploaded = await upload(server.url, bytes)
    const file = (await uploaded.json()) as { fileId: string }
    const opened = await fetch(`${server.url}/v1/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: file.fileId }),
    })
    const session = (await opened.json()) as {
      sessionId: string
      fonts: Array<{ id: string; family: string }>
    }
    expect(session.fonts[0]?.family).toBe('Carlito')
    expect(
      (session as { model?: { page?: { pageWidth: number } } }).model?.page?.pageWidth,
    ).toBeGreaterThan(0)
    const font = await fetch(
      `${server.url}/v1/sessions/${session.sessionId}/fonts/${session.fonts[0].id}`,
    )
    expect(font.status).toBe(200)
    expect(font.headers.get('content-type')).toBe('font/ttf')
    expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000)
    await fetch(`${server.url}/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
  })

  it('restores a DOCX session after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parse-server-docx-restart-'))
    const first = await createParseServer({ dataDir: dir })
    try {
      const bytes = await readFile(join(process.cwd(), 'tests', 'fixtures', 'docx', 'table.docx'))
      const uploaded = await upload(first.url, bytes)
      const file = (await uploaded.json()) as { fileId: string }
      const opened = await fetch(`${first.url}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: file.fileId }),
      })
      const session = (await opened.json()) as { sessionId: string }
      const stylesResponse = await fetch(`${first.url}/v1/sessions/${session.sessionId}/styles`)
      expect(stylesResponse.status).toBe(200)
      const styles = (await stylesResponse.json()) as {
        styles: unknown[]
        numbering: unknown[]
      }
      expect(Array.isArray(styles.styles)).toBe(true)
      expect(Array.isArray(styles.numbering)).toBe(true)
      const prefixes = await readdir(join(dir, 'artifacts'))
      const keys = await readdir(join(dir, 'artifacts', prefixes[0]))
      const artifactDir = join(dir, 'artifacts', prefixes[0], keys[0])
      expect(await readdir(artifactDir)).toEqual(['manifest.json', 'units.bin'])
      const manifest = JSON.parse(await readFile(join(artifactDir, 'manifest.json'), 'utf8')) as {
        records: Array<{ sha256: string }>
      }
      expect(manifest.records.length).toBeGreaterThan(0)
      expect(manifest.records[0].sha256).toMatch(/^[0-9a-f]{64}$/)
      await first.close()
      const second = await createParseServer({ dataDir: dir })
      try {
        const units = await fetch(`${second.url}/v1/sessions/${session.sessionId}/units`)
        expect(units.status).toBe(200)
        const listing = (await units.json()) as { items: Array<{ kind: string }> }
        expect(listing.items[0]?.kind).toBe('block-chunk')
        const unit = await fetch(`${second.url}/v1/sessions/${session.sessionId}/units/0`)
        expect(unit.status).toBe(200)
        expect(((await unit.json()) as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0)
      } finally {
        await second.close()
      }
    } finally {
      await first.close().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('exposes Prometheus metrics', async () => {
    const { server } = await start()
    await fetch(`${server.url}/v1/capabilities`)
    const response = await fetch(`${server.url}/metrics`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    const body = await response.text()
    expect(body).toContain('# TYPE genoffice_parse_requests_total counter')
    expect(body).toContain('genoffice_parse_requests_total{method="GET"}')
    expect(body).toContain('genoffice_parse_sessions_active 0')
    expect(body).toContain('genoffice_parse_storage_bytes')
    expect(body).toContain('genoffice_parse_request_duration_seconds_count')
  })

  it('reports structured health metrics', async () => {
    const { server } = await start()
    await fetch(`${server.url}/v1/capabilities`)
    const response = await fetch(`${server.url}/v1/health`)
    expect(response.status).toBe(200)
    const health = (await response.json()) as {
      ok: boolean
      uptimeSec: number
      sessions: number
      activeWorkers: number
      requests: number
      memory: { rss: number }
    }
    expect(health.ok).toBe(true)
    expect(health.uptimeSec).toBeGreaterThanOrEqual(0)
    expect(health.sessions).toBe(0)
    expect(health.activeWorkers).toBe(0)
    expect(health.requests).toBeGreaterThanOrEqual(1)
    expect(health.memory.rss).toBeGreaterThan(0)
  })

  it('streams an upload, stores it by hash and serves it with Range', async () => {
    const { server } = await start()
    const uploaded = await upload(server.url, PDF)
    expect(uploaded.status).toBe(201)
    const meta = (await uploaded.json()) as {
      fileId: string
      sha256: string
      size: number
      format: string
    }
    expect(meta.format).toBe('pdf')
    expect(meta.size).toBe(PDF.length)
    expect(meta.fileId).toBe(meta.sha256)

    const full = await fetch(`${server.url}/v1/files/${meta.fileId}/content`)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await full.arrayBuffer())).toEqual(PDF)

    const ranged = await fetch(`${server.url}/v1/files/${meta.fileId}/content`, {
      headers: { Range: 'bytes=0-3' },
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-3/${PDF.length}`)
    expect(Buffer.from(await ranged.arrayBuffer()).toString('utf8')).toBe('%PDF')

    const suffix = await fetch(`${server.url}/v1/files/${meta.fileId}/content`, {
      headers: { Range: 'bytes=-4' },
    })
    expect(suffix.status).toBe(206)
    expect(Buffer.from(await suffix.arrayBuffer()).toString('utf8')).toBe('EOF\n')

    const invalid = await fetch(`${server.url}/v1/files/${meta.fileId}/content`, {
      headers: { Range: 'bytes=999-' },
    })
    expect(invalid.status).toBe(416)
  })

  it('supports HEAD and metadata, then deletes', async () => {
    const { server } = await start()
    const meta = (await (await upload(server.url, PDF)).json()) as { fileId: string }
    const head = await fetch(`${server.url}/v1/files/${meta.fileId}/content`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(PDF.length))

    const info = await fetch(`${server.url}/v1/files/${meta.fileId}`)
    expect(info.status).toBe(200)
    expect(((await info.json()) as { format: string }).format).toBe('pdf')

    const deleted = await fetch(`${server.url}/v1/files/${meta.fileId}`, { method: 'DELETE' })
    expect(deleted.status).toBe(204)
    expect((await fetch(`${server.url}/v1/files/${meta.fileId}`)).status).toBe(404)
  })

  it('accepts PPTX/DOCX and rejects XLSX', async () => {
    const { server } = await start()
    const pptx = await upload(server.url, await zipWith({ 'ppt/presentation.xml': '<p/>' }))
    expect(pptx.status).toBe(201)
    expect(((await pptx.json()) as { format: string }).format).toBe('pptx')

    const docx = await upload(server.url, await zipWith({ 'word/document.xml': '<w/>' }))
    expect(docx.status).toBe(201)
    expect(((await docx.json()) as { format: string }).format).toBe('docx')

    const xlsx = await upload(server.url, await zipWith({ 'xl/workbook.xml': '<x/>' }))
    expect(xlsx.status).toBe(415)
  })

  it('serves a stored media part with Range', async () => {
    const { server } = await start()
    const zip = new JSZip()
    zip.file('ppt/presentation.xml', '<p:presentation/>')
    zip.file('ppt/media/image1.png', Buffer.from('0123456789'), { compression: 'STORE' })
    const deck = (await (
      await upload(server.url, await zip.generateAsync({ type: 'nodebuffer' }))
    ).json()) as {
      fileId: string
    }
    const part = await fetch(`${server.url}/v1/files/${deck.fileId}/parts/ppt/media/image1.png`, {
      headers: { Range: 'bytes=2-5' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(Buffer.from(await part.arrayBuffer()).toString()).toBe('2345')
    const full = await fetch(`${server.url}/v1/files/${deck.fileId}/parts/ppt/media/image1.png`)
    expect(full.status).toBe(200)
    expect(Buffer.from(await full.arrayBuffer()).toString()).toBe('0123456789')
  })

  it('rejects an upload past the configured limit', async () => {
    const { server } = await start({ limits: { maxUploadBytes: 32 } })
    const response = await upload(server.url, Buffer.alloc(128, 1))
    expect(response.status).toBe(413)
    expect(((await response.json()) as { code: string }).code).toBe('upload_too_large')
  })

  it('returns a signed content URL for token mode', async () => {
    const { server } = await start({ token: 'secret' })
    const uploadResponse = await fetch(`${server.url}/v1/files`, {
      method: 'POST',
      body: PDF,
      headers: { Authorization: 'Bearer secret' },
    })
    const meta = (await uploadResponse.json()) as { fileId: string }
    const signedResponse = await fetch(`${server.url}/v1/files/${meta.fileId}/content-url`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(signedResponse.status).toBe(200)
    const signed = (await signedResponse.json()) as { url: string; expiresAt: string }
    expect(signed.url).toContain('exp=')
    expect(signed.url).toContain('sig=')
    expect(signed.expiresAt).toBeTruthy()
    expect((await fetch(signed.url)).status).toBe(200)
    expect((await fetch(`${server.url}/v1/files/${meta.fileId}/content`)).status).toBe(401)
  })

  it('rejects uploads over the content-store quota', async () => {
    const { server } = await start({ maxStoreBytes: 1024 })
    const response = await upload(server.url, Buffer.concat([PDF, Buffer.alloc(4096, 1)]))
    expect(response.status).toBe(507)
    expect(((await response.json()) as { code: string }).code).toBe('storage_full')
  })

  it('gcs expired unreferenced content', async () => {
    const { server } = await start({ contentTtlMs: 1, gcIntervalMs: 50 })
    const uploaded = await upload(server.url, PDF)
    const meta = (await uploaded.json()) as { fileId: string }
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect((await fetch(`${server.url}/v1/files/${meta.fileId}`)).status).toBe(404)
  })

  it('requires a bearer token on non-public routes when configured', async () => {
    const { server } = await start({ token: 'secret' })
    expect((await fetch(`${server.url}/v1/capabilities`)).status).toBe(200)
    expect((await fetch(`${server.url}/v1/files/abc`)).status).toBe(401)
    const authorized = await fetch(`${server.url}/v1/files/abc`, {
      headers: { Authorization: 'Bearer secret' },
    })
    expect(authorized.status).toBe(404)
  })
})
