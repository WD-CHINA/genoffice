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

const CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Series 1</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`

const FRAME = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="100000" y="100000"/><a:ext cx="3000000" cy="2000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdChart"/></a:graphicData></a:graphic></p:graphicFrame>'

async function deckWithChart(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  const rels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')
  const types = await zip.file('[Content_Types].xml')!.async('string')
  zip.file('ppt/charts/chart1.xml', CHART)
  zip.file('ppt/slides/slide1.xml', slide.replace('</p:spTree>', `${FRAME}</p:spTree>`))
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'))
  zip.file('[Content_Types].xml', types.replace('</Types>',
    '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string) {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'roundtrip-chart-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async () => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(await deckWithChart()),
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

it('round-trips a bar-chart slide across a restart without re-parsing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtrip-chart-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload()
  const sessionId = await first.open(fileId)
  const unit = await first.unit(sessionId)
  expect(JSON.stringify(unit)).toContain('chart')
  await fetch(`${first.server.url}/v1/sessions/${sessionId}`, { method: 'DELETE' })
  await first.server.close()

  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(dataDir)
  const reopened = await second.open(fileId)
  expect(await second.unit(reopened)).toEqual(unit)
  expect(parse).not.toHaveBeenCalled()
  expect((await (await fetch(second.server.url + '/v1/health')).json() as {
    artifacts: { sourceParsesStarted: number }
  }).artifacts.sourceParsesStarted).toBe(0)
})
