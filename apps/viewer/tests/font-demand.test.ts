import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFontDemand, type AvailableFont } from '../src/web/font-demand.ts'
import { createBundledMetrics, type ParsedFace } from '../src/web/bundled-metrics.ts'

const font = (id: string, family: string, names: string[] = [], bold = false): AvailableFont =>
  ({ id, family, names, bold, italic: false })
const catalog = [
  font('latin', 'Carlito', ['Calibri']),
  font('bold', 'Carlito', ['Calibri'], true),
  font('sans', 'Liberation Sans', ['Arial']),
  font('cjk', 'Noto Sans CJK SC', ['微软雅黑']),
  font('arabic', 'Noto Naskh Arabic', ['Tahoma']),
  font('unused', 'Caladea', ['Cambria']),
]
const style = { fontFamily: 'Calibri', fontSizePx: 18, bold: false, italic: false }

test('font demand uses normalized aliases, variants and script fallbacks', () => {
  const demand = createFontDemand(catalog)
  demand.request({ ...style, fontFamily: 'ＣＡＬＩＢＲＩ', bold: true }, 'Hello')
  assert.deepEqual([...demand.ids()], ['bold'])
  demand.request({ ...style, fontFamily: 'Unknown' }, '中文 العربية')
  assert.deepEqual([...demand.ids()], ['bold', 'latin', 'cjk', 'arabic'])
  assert.ok(!demand.ids().has('unused'))
})

test('embedded aliases override bundled ones; failed faces reveal the original fallback', () => {
  const unavailable = new Set<string>()
  const demand = createFontDemand([...catalog, font('embedded', 'Office Private', ['Calibri'])], unavailable)
  demand.request(style, 'Hello')
  assert.ok(demand.ids().has('embedded'))
  unavailable.add('embedded')
  demand.request(style, 'Hello')
  assert.ok(demand.ids().has('latin'))
  assert.ok(!demand.ids().has('unused'))
})

test('selected faces keep original metrics and record dependencies even after canvas refinement', () => {
  const faces: ParsedFace[] = catalog.map((face, index) => ({
    ...face,
    font: {
      unitsPerEm: 1000, ascender: 800 + index, descender: -200,
      getAdvanceWidth: (text, size) => text.length * size * (0.5 + index / 100),
      charToGlyphIndex: (char) => face.id === 'cjk' || char.charCodeAt(0) < 256 ? 1 : 0,
    },
  }))
  const samples = [
    { style, text: 'Hello' },
    { style: { ...style, bold: true }, text: 'World' },
    { style: { ...style, fontFamily: 'Arial' }, text: '中文' },
    { style: { ...style, fontFamily: 'Unknown' }, text: 'العربية' },
  ]
  const all = createBundledMetrics(faces)
  const demand = createFontDemand(catalog)
  const discover = createBundledMetrics([], demand.request)
  for (const sample of samples) discover.provider.measure(sample.text, sample.style)
  const keys = new Set<string>()
  const selected = createBundledMetrics(faces.filter((_, index) => demand.ids().has(catalog[index].id)), undefined, (key) => keys.add(key))
  for (const { text, style: run } of samples) {
    assert.equal(selected.provider.measure(text, run), all.provider.measure(text, run))
    assert.deepEqual(selected.provider.metrics(run), all.provider.metrics(run))
    assert.equal(selected.provider.displayFamily?.(run, text), all.provider.displayFamily?.(run, text))
  }
  const pending = selected.pendingWidthMeasurements()
  assert.equal(keys.size, pending.length)
  selected.acceptWidthMeasurements(Object.fromEntries(pending.map((item) => [item.key, 123])))
  keys.clear()
  assert.equal(selected.provider.measure('Hello', style), 123 / 100 * 18)
  assert.equal(keys.size, 1, 'cached widths still count as slide dependencies')
})
