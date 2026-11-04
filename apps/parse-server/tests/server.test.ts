import { mkdtemp, rm } from 'node:fs/promises'
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
  it('advertises capabilities without DOCX', async () => {
    const { server } = await start()
    const response = await fetch(`${server.url}/v1/capabilities`)
    expect(response.status).toBe(200)
    const caps = (await response.json()) as { formats: string[]; contractVersion: number }
    expect(caps.contractVersion).toBe(1)
    expect(caps.formats).toEqual(['pptx', 'pdf'])
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

  it('accepts PPTX and rejects DOCX/XLSX', async () => {
    const { server } = await start()
    const pptx = await upload(server.url, await zipWith({ 'ppt/presentation.xml': '<p/>' }))
    expect(pptx.status).toBe(201)
    expect(((await pptx.json()) as { format: string }).format).toBe('pptx')

    const docx = await upload(server.url, await zipWith({ 'word/document.xml': '<w/>' }))
    expect(docx.status).toBe(415)
    expect(((await docx.json()) as { code: string }).code).toBe('unsupported_format')

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
