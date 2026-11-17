import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import opentype from 'opentype.js'
import { layoutText, makeViewport } from '@genoffice/pptx-render'
import { decodeSymbolChar } from '../../../packages/docx-engine/src/symbol-fonts.ts'
import { createBundledMetrics, type ParsedFace } from '../src/web/bundled-metrics.ts'
import { createMetricFontLoader, fontFromAdvances } from '../src/web/load-metric-font.ts'
import type { MetricFont } from '../src/web/metric-font-types.ts'
import { createFontDemand } from '../src/web/font-demand.ts'

const root = resolve(import.meta.dirname, '../../..')
const catalog: Array<MetricFont & { path: string }> = JSON.parse(
  readFileSync(resolve(root, 'apps/viewer/src/web/fonts/catalog.json'), 'utf8'),
)
for (const font of catalog) {
  font.url = resolve(root, font.path)
  if (font.path.endsWith('.woff2'))
    font.metricsUrl = resolve(
      root,
      'apps/viewer/src/web/fonts/metrics',
      basename(font.path, '.woff2') + '.json',
    )
}
const reads = new Map<string, number>()
const loader = createMetricFontLoader(async (input) => {
  const path = String(input)
  reads.set(path, (reads.get(path) ?? 0) + 1)
  return new Response(readFileSync(path))
})
const parsed = Promise.all(catalog.map(loader)).then((faces) => {
  assert.ok(faces.every(Boolean), 'all shipped faces must have usable worker metrics')
  return faces as ParsedFace[]
})
const style = { fontFamily: 'Calibri', fontSizePx: 100, bold: false, italic: false }

test('PPT catalog covers all migrated font files and WOFF2 sidecars match source hashes', async () => {
  const provenance = JSON.parse(
    readFileSync(resolve(root, 'apps/viewer/src/web/fonts/catalog-provenance.json'), 'utf8'),
  )
  for (const [path, hash] of Object.entries(provenance))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
      hash,
      `Regenerate PPT catalog after changing ${path}`,
    )
  for (const dir of [
    'packages/viewer-renderers/src/docs/renderer/fonts',
    'packages/ui/src/fonts',
  ]) {
    for (const file of readdirSync(resolve(root, dir)).filter((name) =>
      /\.(ttf|woff2)$/.test(name),
    ))
      assert.ok(
        catalog.some((font) => font.path === `${dir}/${file}`),
        `PPT catalog missing ${file}`,
      )
  }
  for (const font of catalog.filter((font) => font.metricsUrl)) {
    const metadata = JSON.parse(readFileSync(font.metricsUrl!, 'utf8'))
    assert.equal(
      metadata.sourceSha256,
      createHash('sha256').update(readFileSync(font.url)).digest('hex'),
    )
  }
  await parsed
  assert.ok(
    [...reads.values()].every((count) => count <= 2),
    'range aliases reuse parsed source fonts',
  )
})

test('all five symbol maps have outlines in their byte/PUA or Unicode forms', () => {
  for (const family of ['Symbol', 'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Webdings']) {
    const entry = catalog.find((font) => font.names.includes(family))!
    const bytes = readFileSync(entry.url)
    const font = opentype.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    )
    let count = 0
    for (let code = 0x21; code <= 0xff; code++) {
      const unicode = decodeSymbolChar(family, code)
      if (unicode == null) continue
      count++
      assert.ok(
        font.charToGlyphIndex(String.fromCodePoint(0xf000 + code)) > 0,
        `${family} missing F0${code.toString(16)}`,
      )
      assert.ok(
        font.charToGlyphIndex(family === 'Symbol' ? unicode : String.fromCodePoint(code)) > 0,
      )
    }
    assert.ok(count >= 180)
  }
})

test('the shared symbol decoder and bundled fonts agree for complete text runs', async () => {
  const faces = await parsed
  const metrics = createBundledMetrics(faces).provider
  for (const family of ['Symbol', 'Wingdings', 'Wingdings 2', 'Wingdings 3', 'Webdings']) {
    const codes = Array.from({ length: 223 }, (_, index) => index + 0x21).filter(
      (code) => decodeSymbolChar(family, code) != null,
    )
    const text = codes
      .flatMap((code) => [String.fromCodePoint(code), String.fromCodePoint(0xf000 + code)])
      .join(' ')
    const laid = layoutText({
      body: {
        anchor: 'top',
        autofit: 'none',
        wrap: false,
        insets: { l: 0, t: 0, r: 0, b: 0 },
        paragraphs: [{ runs: [{ text, fontFamily: family, fontSize: 12, cap: 'all' }] }],
      },
      boxWidthPx: 100000,
      boxHeightPx: 1000,
      metrics,
      vp: makeViewport({ cx: 9525000, cy: 9525000 }, 1000),
    })
    const runs = laid.lines.flatMap((line) => line.runs)
    assert.ok(runs.length > 0)
    for (const run of runs) {
      const source = faces.find((face) => face.family === run.fontFamily)!
      assert.ok(source, run.fontFamily)
      for (const char of run.text)
        if (char.trim())
          assert.ok(
            source.font.charToGlyphIndex?.(char),
            `${family} decoded to an uncovered glyph U+${char.codePointAt(0)!.toString(16)}`,
          )
    }
  }
})

test('PPT aliases use actual migrated faces; mixed scripts use covered script faces', async () => {
  const metrics = createBundledMetrics(await parsed).provider
  const cases = [
    ['Aptos', 'Aptos GO', 'Heading'],
    ['Calibri Light', 'Calibri Light GO', 'Heading'],
    ['Bookman Old Style', 'Bookman Old Style GO', 'Heading'],
    ['Century Gothic', 'Century Gothic GO', 'Heading'],
    ['Segoe UI', 'Segoe UI GO', 'Heading'],
    ['Montserrat', 'Montserrat GO', 'Heading'],
    ['Nunito Sans', 'Nunito Sans GO', 'Heading'],
    ['DM Sans', 'GenOffice DM Sans', 'Heading'],
    ['Poppins', 'GenOffice Poppins', 'Heading'],
    ['Consolas', 'Consolas GO', 'Code'],
    ['Sarabun', 'GenOffice Sarabun', 'การศึกษา'],
    ['Nirmala UI', 'GenOffice Bengali', 'বাংলা'],
    ['Latha', 'GenOffice Tamil', 'தமிழ்'],
    ['NanumGothic', 'GenOffice Gothic KR', '한글'],
    ['Malgun Gothic', 'GenOffice Sans KR', '한글'],
    ['Batang', 'GenOffice Serif KR', '한글'],
    ['Arial', 'GenOffice Sans KR', '한글'],
    ['Times New Roman', 'Noto Serif CJK SC', '矩阵'],
    ['Cambria', 'Cambria Cyrillic GO', 'БГДЖ'],
    ['Dubai', 'Dubai GO', 'العربية'],
    ['Sakkal Majalla', 'Sakkal Majalla GO', 'العربية'],
    ['Simplified Arabic', 'Noto Naskh Arabic SA', 'العربية'],
    ['Traditional Arabic', 'Noto Naskh Arabic TA', 'العربية'],
  ]
  for (const [fontFamily, expected, text] of cases) {
    const run = { ...style, fontFamily: fontFamily! }
    assert.equal(metrics.displayFamily?.(run, text), expected, fontFamily)
    assert.ok(metrics.measure(text!, run) > 0, fontFamily)
  }
  const aptos = catalog.find(
    (font) =>
      font.family === 'Aptos GO' &&
      !font.bold &&
      !font.italic &&
      font.path.includes('AptosGO-Regular'),
  )!
  const bytes = readFileSync(aptos.url)
  const original = opentype.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  assert.equal(
    metrics.measure('Aptos', { ...style, fontFamily: 'Aptos' }),
    original.getAdvanceWidth('Aptos', 100),
  )
})

test('range cascades and metric overrides apply equally to advances and line boxes', () => {
  const base: ParsedFace = {
    family: 'Test GO',
    names: ['Test'],
    bold: false,
    italic: false,
    font: {
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      lineGap: 100,
      charToGlyphIndex: () => 1,
      getAdvanceWidth: (text, size) => (text.length * size) / 2,
    },
  }
  const ranged: ParsedFace = {
    ...base,
    descriptors: {
      unicodeRange: 'U+0041',
      sizeAdjust: '200%',
      ascentOverride: '50%',
      descentOverride: '20%',
      lineGapOverride: '10%',
    },
  }
  const metrics = createBundledMetrics([base, ranged]).provider
  const run = { ...style, fontFamily: 'Test' }
  assert.equal(metrics.measure('AB', run), 150)
  assert.deepEqual(metrics.metrics(run), {
    ascent: 100,
    descent: 40,
    lineHeight: 140,
    externalLeading: 20,
  })
  const demand = createFontDemand([
    { ...base, id: 'base' },
    { ...ranged, id: 'range' },
  ])
  demand.request(run, 'AB')
  assert.deepEqual([...demand.ids()], ['base', 'range'])
})

test('WOFF2 metrics retain zero-width marks and actual glyph coverage', () => {
  const font = fontFromAdvances({
    unitsPerEm: 1000,
    ascender: 900,
    descender: -300,
    lineGap: 0,
    advances: [
      [65, 1, 600],
      [0x301, 2, 0],
    ],
  })
  assert.equal(font.getAdvanceWidth('A\u0301', 100), 60)
  assert.equal(font.charToGlyphIndex?.('\u0301'), 2)
  assert.equal(font.charToGlyphIndex?.('中'), 0)
})
