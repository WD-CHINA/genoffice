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

/** A multi-slide deck exercises unit indexing and per-slide model round-trips. */
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
  zip.file('ppt/_rels/presentation.xml.rels',
    rels.replace('</Relationships>', `${relationships}</Relationships>`))
  zip.file('[Content_Types].xml', types.replace('</Types>', `${overrides}</Types>`))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string): Promise<{
  server: ParseServer
  upload: (bytes: Uint8Array) => Promise<string>
  open: (fileId: string) => Promise<string>
  unit: (sessionId: string, index: number) => Promise<unknown>
}> {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'roundtrip-pptx-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async (bytes) => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(bytes),
      })
      return ((await response.json()) as { fileId: string }).fileId
    },
    open: async (fileId) => {
      const response = await request('/v1/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
      return ((await response.json()) as { sessionId: string }).sessionId
    },
    unit: async (sessionId, index) => {
      const response = await request(`/v1/sessions/${sessionId}/units/${index}`)
      expect(response.status, await response.clone().text()).toBe(200)
      return response.json()
    },
  }
}

it('round-trips every slide model of a multi-slide deck across a restart without re-parsing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtrip-pptx-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload(await multiSlidePptx(5, 'roundtrip'))
  const sessionId = await first.open(fileId)
  const units = []
  for (let index = 0; index < 5; index++) units.push(await first.unit(sessionId, index))
  expect(units.every((unit) => unit && typeof unit === 'object')).toBe(true)
  await fetch(`${first.server.url}/v1/sessions/${sessionId}`, { method: 'DELETE' })
  await first.server.close()

  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(dataDir)
  const reopened = await second.open(fileId)
  for (let index = 0; index < 5; index++) {
    expect(await second.unit(reopened, index)).toEqual(units[index])
  }
  expect(parse).not.toHaveBeenCalled()
  expect((await (await fetch(second.server.url + '/v1/health')).json() as {
    artifacts: { sourceParsesStarted: number }
  }).artifacts.sourceParsesStarted).toBe(0)
})
