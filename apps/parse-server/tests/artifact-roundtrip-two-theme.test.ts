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

const SHAPE = (id: number, text: string) =>
  '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="Shape ' + id + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000000" cy="800000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp>'

async function twoThemeDeck(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const slide1 = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const slide1Rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  const master = await zip.file('ppt/slideMasters/slideMaster1.xml')!.async('string')
  const masterRels = await zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels')!.async('string')
  const layout = await zip.file('ppt/slideLayouts/slideLayout1.xml')!.async('string')
  const layoutRels = await zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels')!.async('string')
  const theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
  const presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const presentationRels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')

  // Slide 1 keeps theme1 accent1 (FF00AA), slide 2 gets theme2 accent1 (00AAFF).
  zip.file('ppt/slides/slide1.xml', slide1.replace('</p:spTree>', SHAPE(2, 'theme one') + '</p:spTree>'))
  zip.file('ppt/slides/slide2.xml', slide1.replace('</p:spTree>', SHAPE(3, 'theme two') + '</p:spTree>'))
  zip.file('ppt/theme/theme1.xml', theme.replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="FF00AA"/></a:accent1>'))
  zip.file('ppt/theme/theme2.xml', theme.replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="00AAFF"/></a:accent1>'))

  zip.file('ppt/slideMasters/slideMaster2.xml', master)
  zip.file('ppt/slideMasters/_rels/slideMaster2.xml.rels', masterRels
    .replace(/Target="\.\.\/slideLayouts\/slideLayout1\.xml"/, 'Target="../slideLayouts/slideLayout2.xml"')
    .replace(/Target="\.\.\/theme\/theme1\.xml"/, 'Target="../theme/theme2.xml"'))
  zip.file('ppt/slideLayouts/slideLayout2.xml', layout)
  zip.file('ppt/slideLayouts/_rels/slideLayout2.xml.rels', layoutRels
    .replace(/Target="\.\.\/slideMasters\/slideMaster1\.xml"/, 'Target="../slideMasters/slideMaster2.xml"'))
  zip.file('ppt/slides/_rels/slide2.xml.rels', slide1Rels
    .replace(/Target="\.\.\/slideLayouts\/slideLayout1\.xml"/, 'Target="../slideLayouts/slideLayout2.xml"'))

  zip.file('ppt/presentation.xml', presentation
    .replace('<p:sldMasterIdLst>', '<p:sldMasterIdLst><p:sldMasterId id="2147483649" r:id="rIdMaster2"/>')
    .replace('</p:sldIdLst>', '<p:sldId id="257" r:id="rIdSlide2"/></p:sldIdLst>'))
  zip.file('ppt/_rels/presentation.xml.rels', presentationRels.replace('</Relationships>',
    '<Relationship Id="rIdMaster2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster2.xml"/>'
    + '<Relationship Id="rIdSlide2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>'))
  zip.file('[Content_Types].xml', types.replace('</Types>',
    '<Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>'))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string) {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'two-theme-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async () => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(await twoThemeDeck()),
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
    slide: async (sessionId: string, index: number) => {
      const response = await request(`/v1/sessions/${sessionId}/layout/slides/${index}`)
      expect(response.status, await response.clone().text()).toBe(200)
      return response.json()
    },
  }
}

it('resolves two different slide themes across the artifact round-trip', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'two-theme-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload()
  const sessionId = await first.open(fileId)
  const one = await first.slide(sessionId, 0)
  const two = await first.slide(sessionId, 1)
  expect(JSON.stringify(one)).toContain('FF00AA')
  expect(JSON.stringify(two)).toContain('00AAFF')
  await fetch(`${first.server.url}/v1/sessions/${sessionId}`, { method: 'DELETE' })
  await first.server.close()

  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(dataDir)
  const reopened = await second.open(fileId)
  expect(await second.slide(reopened, 0)).toEqual(one)
  expect(await second.slide(reopened, 1)).toEqual(two)
  expect(parse).not.toHaveBeenCalled()
  expect((await (await fetch(second.server.url + '/v1/health')).json() as {
    artifacts: { sourceParsesStarted: number }
  }).artifacts.sourceParsesStarted).toBe(0)
})
