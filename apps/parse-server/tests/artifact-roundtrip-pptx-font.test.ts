import { createBlankPptx } from '@genoffice/pptx-engine'
import JSZip from 'jszip'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

async function deckWithEmbeddedFont(): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const font = await readFile(join(process.cwd(), '../../packages/ui/src/fonts/Carlito-Regular.ttf'))
  let presentation = await zip.file('ppt/presentation.xml')!.async('string')
  const rels = await zip.file('ppt/_rels/presentation.xml.rels')!.async('string')
  zip.file('ppt/fonts/font1.fntdata', font)
  presentation = presentation
    .replace('<p:presentation ', '<p:presentation embedTrueTypeFonts="1" saveSubsetFonts="1" ')
    .replace('</p:presentation>',
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="RoundtripFont"/><p:regular r:id="rIdFont"/></p:embeddedFont></p:embeddedFontLst></p:presentation>')
  zip.file('ppt/presentation.xml', presentation)
  zip.file('ppt/_rels/presentation.xml.rels', rels.replace('</Relationships>',
    '<Relationship Id="rIdFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>'))
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function setup(dataDir: string) {
  const server = await createParseServer({
    dataDir, parserVersion: '0.1.0', parserFingerprint: 'roundtrip-font-test', maxParseJobs: 1,
  })
  servers.push(server)
  const request = (path: string, init?: RequestInit) => fetch(server.url + path, init)
  return {
    server,
    upload: async () => {
      const response = await request('/v1/files', {
        method: 'POST', body: Buffer.from(await deckWithEmbeddedFont()),
      })
      return ((await response.json()) as { fileId: string }).fileId
    },
    open: async (fileId: string) => {
      const response = await request('/v1/sessions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId }),
      })
      expect(response.status, await response.clone().text()).toBe(201)
      return await response.json() as {
        sessionId: string; fonts?: Array<{ id: string; family: string }>
      }
    },
  }
}

it('round-trips an embedded PPTX font across a restart without re-parsing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'roundtrip-font-'))
  dirs.push(dataDir)
  const first = await setup(dataDir)
  const fileId = await first.upload()
  const opened = await first.open(fileId)
  expect(opened.fonts?.some((font) => font.family === 'RoundtripFont')).toBe(true)
  const fonts = opened.fonts
  await fetch(`${first.server.url}/v1/sessions/${opened.sessionId}`, { method: 'DELETE' })
  await first.server.close()

  const parse = vi.spyOn(PptxSession, 'open')
  const second = await setup(dataDir)
  const reopened = await second.open(fileId)
  expect(reopened.fonts).toEqual(fonts)
  expect(parse).not.toHaveBeenCalled()
  expect((await (await fetch(second.server.url + '/v1/health')).json() as {
    artifacts: { sourceParsesStarted: number }
  }).artifacts.sourceParsesStarted).toBe(0)
})
