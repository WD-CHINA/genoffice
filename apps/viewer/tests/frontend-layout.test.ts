import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import opentype from 'opentype.js'
import { materializeSlide, openPptx } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { createBundledMetrics } from '../src/web/bundled-metrics.ts'

const root = resolve(import.meta.dirname, '../../..')

function textOf(slide: { nodes: readonly unknown[] }) {
  return slide.nodes
    .flatMap((node) => (node as { text?: { lines?: Array<{ runs?: Array<{ text?: string }> }> } }).text?.lines || [])
    .flatMap((line) => line.runs || [])
    .map((run) => run.text || '')
    .join('')
}

test('bundled metrics keep fixture slides and Calibri maps to Carlito', async () => {
  const bytes = new Uint8Array(readFileSync(resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')))
  const file = readFileSync(resolve(root, 'packages/ui/src/fonts/Carlito-Regular.ttf'))
  const font = opentype.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength))
  const bundled = createBundledMetrics([
    {
      family: 'Carlito',
      bold: false,
      italic: false,
      names: ['Carlito', 'Calibri', 'Calibri Light'],
      font,
    },
  ])
  assert.equal(
    bundled.provider.displayFamily?.(
      { fontFamily: 'Calibri', fontSizePx: 18, bold: false, italic: false },
      'Hello',
    ),
    'Carlito',
  )
  const opened = await openPptx(bytes)
  opened.deck.slides.forEach((_, index) => materializeSlide(opened, index))
  const slides = opened.deck.slides.map((slide, index) =>
    buildRenderSlide(slide, opened.deck.size, {
      fitWidthPx: 960,
      metrics: bundled.provider,
      slideNo: index + 1,
    }),
  )
  assert.equal(slides.length, opened.deck.slides.length)
  assert.ok(slides.length > 1)
  const text = slides.map(textOf).join('')
  assert.ok(text.length > 20)
  const again = opened.deck.slides.map((slide, index) =>
    buildRenderSlide(slide, opened.deck.size, {
      fitWidthPx: 960,
      metrics: bundled.provider,
      slideNo: index + 1,
    }),
  )
  assert.equal(again.map(textOf).join(''), text)
  assert.equal(again.map((slide) => slide.nodes.length).join(','), slides.map((slide) => slide.nodes.length).join(','))
})
