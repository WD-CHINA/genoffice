import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFontDemand, type AvailableFont } from '../src/web/font-demand.ts'
import { createBundledMetrics, type ParsedFace } from '../src/web/bundled-metrics.ts'
import { createScriptFallback } from '@genoffice/viewer-services/slides/shared/script-fallback'

const font = (id: string, family: string, names: string[] = [], bold = false): AvailableFont => ({
  id,
  family,
  names,
  bold,
  italic: false,
})
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
  const demand = createFontDemand(
    [...catalog, font('embedded', 'Office Private', ['Calibri'])],
    unavailable,
  )
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
      unitsPerEm: 1000,
      ascender: 800 + index,
      descender: -200,
      getAdvanceWidth: (text, size) => text.length * size * (0.5 + index / 100),
      charToGlyphIndex: (char) => (face.id === 'cjk' || char.charCodeAt(0) < 256 ? 1 : 0),
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
  const selected = createBundledMetrics(
    faces.filter((_, index) => demand.ids().has(catalog[index].id)),
    undefined,
    (key) => keys.add(key),
  )
  for (const { text, style: run } of samples) {
    assert.equal(selected.provider.measure(text, run), all.provider.measure(text, run))
    assert.deepEqual(selected.provider.metrics(run), all.provider.metrics(run))
    assert.equal(
      selected.provider.displayFamily?.(run, text),
      all.provider.displayFamily?.(run, text),
    )
  }
  const pending = selected.pendingWidthMeasurements()
  assert.equal(keys.size, pending.length)
  selected.acceptWidthMeasurements(Object.fromEntries(pending.map((item) => [item.key, 123])))
  keys.clear()
  assert.equal(selected.provider.measure('Hello', style), (123 / 100) * 18)
  assert.equal(keys.size, 1, 'cached widths still count as slide dependencies')
})

test('eviction discards orphaned measured and pending text widths', () => {
  const metrics = createBundledMetrics([])
  metrics.provider.measure('kept', style)
  metrics.provider.measure('evicted', style)
  const [kept, evicted] = metrics.pendingWidthMeasurements()
  metrics.acceptWidthMeasurements({ [kept.key]: 123, [evicted.key]: 456 })
  metrics.provider.measure('pending orphan', style)
  metrics.retainWidthMeasurements(new Set([kept.key]))
  assert.deepEqual(metrics.pendingWidthMeasurements(), [])
  assert.equal(metrics.provider.measure('kept', style), (123 / 100) * style.fontSizePx)
  metrics.provider.measure('evicted', style)
  assert.deepEqual(
    metrics.pendingWidthMeasurements().map((item) => item.key),
    [evicted.key],
  )
})

test('main script decisions select JA/KO faces only for missing glyphs and keep portable fallback', () => {
  const face = (family: string, glyph: (char: string) => boolean, advance: number): ParsedFace => ({
    family,
    names: [],
    bold: false,
    italic: false,
    font: {
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      charToGlyphIndex: (char) => (glyph(char) ? 1 : 0),
      getAdvanceWidth: (text, size) => text.length * size * advance,
    },
  })
  const latin = face('Calibri', (char) => char.codePointAt(0)! < 256, 0.5)
  const ja = face('Yu Gothic', (char) => /[\u3040-\u30ffA-Za-z]/.test(char), 0.8)
  const ko = face('Malgun Gothic', (char) => /[가-힣A-Za-z]/.test(char), 0.9)
  const portable = face('Noto Sans CJK SC', () => true, 1)
  const provider = createBundledMetrics([latin, ja, ko, portable]).provider
  assert.equal(provider.displayFamily?.({ ...style, substScript: 'ja' }, 'かな'), 'Yu Gothic')
  assert.equal(provider.displayFamily?.({ ...style, substScript: 'ko' }, '가'), 'Malgun Gothic')
  assert.equal(provider.measure('かな', { ...style, substScript: 'ja' }), 2 * 18 * 0.8)
  assert.equal(provider.displayFamily?.(style, 'かな'), 'Noto Sans CJK SC')
  assert.equal(
    provider.displayFamily?.({ ...style, fontFamily: 'Yu Gothic', substScript: 'ja' }, 'かな'),
    'Yu Gothic',
  )
  assert.equal(
    createBundledMetrics([latin, portable]).provider.displayFamily?.(
      { ...style, substScript: 'ja' },
      'かな',
    ),
    'Noto Sans CJK SC',
  )
  const embedded = face('Office Embedded', () => true, 0.7)
  assert.equal(
    createBundledMetrics([embedded, ja]).provider.displayFamily?.(
      { ...style, fontFamily: embedded.family, substScript: 'ja' },
      'かな',
    ),
    embedded.family,
  )
  const demand = createFontDemand([
    font('latin', 'Calibri'),
    font('ja', 'Yu Gothic'),
    font('ko', 'Malgun Gothic'),
    font('cjk', 'Noto Sans CJK SC'),
  ])
  demand.request({ ...style, substScript: 'ja' }, 'かな')
  demand.request({ ...style, substScript: 'ko' }, '가')
  assert.ok(demand.ids().has('ja') && demand.ids().has('ko'))
})

test('main Nyala and Arial fallbacks require an available non-substituted face with the glyph', () => {
  const covered = { font: { charToGlyphIndex: () => 1 }, substituted: false }
  const missing = { font: { charToGlyphIndex: () => 0 } }
  const prefer = createScriptFallback(() => covered)
  assert.equal(prefer('አ', missing, style), 'Nyala')
  assert.equal(prefer('●', missing, style), 'Arial')
  assert.equal(prefer('●', covered, style), undefined)
  assert.equal(createScriptFallback(() => undefined)('●', missing, style), undefined)
  assert.equal(
    createScriptFallback(() => ({ ...covered, substituted: true }))('አ', missing, style),
    undefined,
  )
  assert.equal(createScriptFallback(() => missing)('አ', missing, style), undefined)
})
