import { createBlankPptx } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
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

const SHAPE = '<p:sp><p:nvSpPr><p:cNvPr id="11" name="Themed"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="800000" cy="300000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>render equivalence</a:t></a:r></a:p></p:txBody></p:sp>'
const GROUP = '<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="800000" cy="300000"/><a:chOff x="0" y="0"/><a:chExt cx="800000" cy="300000"/></a:xfrm></p:grpSpPr>' + SHAPE + '</p:grpSp>'
const TIMING = '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="5" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="11"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'

async function deck(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  let slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  slide = slide.replace('</p:spTree>', GROUP + '</p:spTree>').replace('</p:sld>', TIMING + '</p:sld>')
  zip.file('ppt/slides/slide1.xml', slide)
  let theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
  theme = theme.replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="FF00AA"/></a:accent1>')
  zip.file('ppt/theme/theme1.xml', theme)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string) {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'render-equivalence-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async () => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(await deck()),
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
    layout: async (sessionId: string) => {
      const response = await request(`/v1/sessions/${sessionId}/layout/slides/0`)
      expect(response.status, await response.clone().text()).toBe(200)
      return await response.json() as { slide: unknown; size: { cx: number; cy: number } }
    },
  }
}

const render = (unit: { slide: unknown; size: { cx: number; cy: number } }) =>
  JSON.stringify(buildRenderSlide(unit.slide as never, unit.size as never, { fitWidthPx: 960 }))

it('reopened artifact produces the identical render tree for grouped/themed/animated content', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'render-equivalence-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload()
  const sessionId = await first.open(fileId)
  const unit = await first.layout(sessionId)
  const tree = render(unit)
  expect(tree).toContain('FF00AA')
  await fetch(`${first.server.url}/v1/sessions/${sessionId}`, { method: 'DELETE' })
  await first.server.close()

  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(dataDir)
  const reopened = await second.open(fileId)
  const unit2 = await second.layout(reopened)
  expect(unit2).toEqual(unit)
  expect(render(unit2)).toBe(tree)
  expect(parse).not.toHaveBeenCalled()
  expect((await (await fetch(second.server.url + '/v1/health')).json() as {
    artifacts: { sourceParsesStarted: number }
  }).artifacts.sourceParsesStarted).toBe(0)
})