import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import opentype from 'opentype.js'
import JSZip from 'jszip'
import { materializeSlide, openPptx } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { createBundledMetrics, type ParsedFace } from '../src/web/bundled-metrics.ts'
import { createFontDemand } from '../src/web/font-demand.ts'

const root = resolve(import.meta.dirname, '../../..')
const bytes = readFileSync(
  resolve(root, 'apps/viewer/src/web/fonts/GenOfficeWingdings-Regular.ttf'),
)
const font = opentype.parse(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
)
const face: ParsedFace = {
  family: 'GenOffice Wingdings',
  names: ['Wingdings'],
  bold: false,
  italic: false,
  font,
}

test('bundled Wingdings draws legacy byte and PUA codes with real monochrome outlines', () => {
  for (const code of [0x70, 0x71, 0xa7, 0xfc]) {
    const raw = font.charToGlyph(String.fromCodePoint(code))
    const pua = font.charToGlyph(String.fromCodePoint(0xf000 + code))
    assert.ok(raw.index > 0, `missing glyph ${code.toString(16)}`)
    assert.equal(raw.index, pua.index)
    assert.ok(raw.path.commands.length > 0)
    assert.ok((raw.advanceWidth ?? 0) > 0)
  }
})

test('PPTX Wingdings text and list bullets measure and draw with the bundled face', async () => {
  const zip = await JSZip.loadAsync(
    readFileSync(resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')),
  )
  const path = 'ppt/slides/slide1.xml'
  const xml = await zip.file(path)!.async('string')
  // The first paragraph matches the actual Chap03 run: Wingdings F070 + space,
  // followed by Chinese in a different face. Also cover raw-byte list bullets.
  const paragraphs =
    `<a:p><a:pPr><a:buNone/></a:pPr><a:r><a:rPr sz="2196"><a:latin typeface="Wingdings"/></a:rPr><a:t>\uf070 </a:t></a:r><a:r><a:rPr sz="2196"><a:latin typeface="微软雅黑"/></a:rPr><a:t>全局散度矩阵</a:t></a:r></a:p>` +
    ['p', '\uf070']
      .map(
        (char) =>
          `<a:p><a:pPr><a:buFont typeface="Wingdings"/><a:buChar char="${char}"/></a:pPr><a:r><a:rPr sz="2196"/><a:t>类内散度矩阵</a:t></a:r></a:p>`,
      )
      .join('')
  zip.file(
    path,
    xml.replace(
      '</p:spTree>',
      `<p:sp><p:nvSpPr><p:cNvPr id="987" name="symbol regression"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="8000000" cy="4000000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp></p:spTree>`,
    ),
  )
  const opened = await openPptx(await zip.generateAsync({ type: 'uint8array' }))
  materializeSlide(opened, 0)
  const bundled = createBundledMetrics([face])
  const rendered = buildRenderSlide(opened.deck.slides[0]!, opened.deck.size, {
    fitWidthPx: 960,
    metrics: bundled.provider,
  })
  const runs = rendered.nodes.flatMap((node) =>
    'text' in node ? (node.text?.lines.flatMap((line) => line.runs) ?? []) : [],
  )
  const markers = runs.filter((run) => run.text === '\uf070')
  assert.equal(markers.length, 3)
  assert.ok(markers.every((run) => run.fontFamily === face.family && run.widthPx > 0))
  assert.ok(runs.some((run) => run.text.includes('全') && run.fontFamily !== face.family))
  const demand = createFontDemand([{ ...face, id: 'wingdings' }])
  demand.request({ fontFamily: 'Wingdings', fontSizePx: 22, bold: true, italic: false }, '\uf070')
  assert.ok(demand.ids().has('wingdings'), 'bold symbols still request the regular symbol face')
  const embedded = { ...face, family: 'Embedded Wingdings' }
  const metrics = createBundledMetrics([face, embedded])
  assert.equal(
    metrics.provider.displayFamily?.(
      { fontFamily: 'Wingdings', fontSizePx: 22, bold: false, italic: false },
      '\uf070',
    ),
    embedded.family,
  )
})
