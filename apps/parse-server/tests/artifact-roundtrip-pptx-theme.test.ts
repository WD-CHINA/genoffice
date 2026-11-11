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

const SHAPE = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Themed shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="100000"/></a:schemeClr></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>theme</a:t></a:r></a:p></p:txBody></p:sp>'

async function deckWithTheme(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  let slide = await zip.file('ppt/slides/slide1.xml')!.async('string')
  slide = slide.replace('</p:spTree>', SHAPE + '</p:spTree>')
  zip.file('ppt/slides/slide1.xml', slide)
  let theme = await zip.file('ppt/theme/theme1.xml')!.async('string')
  theme = theme.replace(/<a:accent1>[\s\S]*?<\/a:accent1>/, '<a:accent1><a:srgbClr val="FF00AA"/></a:accent1>')
  zip.file('ppt/theme/theme1.xml', theme)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string) {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'roundtrip-theme-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async () => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(await deckWithTheme()),
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

it('round-trips a theme scheme color through the artifact without re-parsing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtrip-theme-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload()
  const sessionId = await first.open(fileId)
  const unit = await first.unit(sessionId)
  expect(JSON.stringify(unit).toUpperCase()).toContain('FF00AA')
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
