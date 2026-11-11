import { createBlankPptx } from '@genoffice/pptx-engine'
import JSZip from 'jszip'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PptxSession } from '../src/pptx'
import { createParseServer, type ParseServer } from '../src/server'

const dirs: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// 1x1 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PIC = '<p:pic><p:nvPicPr><p:cNvPr id="99" name="Picture 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'

async function deckWithImage(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file('ppt/media/image1.png', PNG)
  zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', `${PIC}</p:spTree>`))
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>'))
  zip.file('[Content_Types].xml', types.replace('</Types>',
    '<Default Extension="png" ContentType="image/png"/></Types>'))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string) {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'roundtrip-image-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async () => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(await deckWithImage()),
      })
      return ((await response.json()) as { fileId: string }).fileId
    },
    open: async (fileId: string) => {
      const response = await request('/v1/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      return ((await response.json()) as { sessionId: string }).sessionId
    },
    unit: async (sessionId: string) => {
      const response = await request(`/v1/sessions/${sessionId}/units/0`)
      expect(response.status, await response.clone().text()).toBe(200)
      return response.json()
    },
  }
}

it('round-trips an embedded image slide model across a restart without re-parsing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtrip-image-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload()
  const sessionId = await first.open(fileId)
  const unit = await first.unit(sessionId)
  const serialized = JSON.stringify(unit)
  expect(serialized).toContain('image1.png')
  await fetch(`${first.server.url}/v1/sessions/${sessionId}`, { method: 'DELETE' })
  await first.server.close()

  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(dataDir)
  const reopened = await second.open(fileId)
  // Signed part URLs carry the current origin/port; compare canonical payloads.
  const canonical = (value: unknown) =>
    JSON.stringify(value).replace(/https?:\/\/[^"]+/g, 'http://server')
  expect(canonical(await second.unit(reopened))).toBe(canonical(unit))
  expect(parse).not.toHaveBeenCalled()
  expect((await (await fetch(second.server.url + '/v1/health')).json() as {
    artifacts: { sourceParsesStarted: number }
  }).artifacts.sourceParsesStarted).toBe(0)
})
