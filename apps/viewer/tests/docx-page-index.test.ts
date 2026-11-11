import assert from 'node:assert/strict'
import { test } from 'node:test'
import { indexDocxUnit } from '../src/web/docx-page-index.ts'
import { paginateBlocks } from '../src/web/docx-pagination.ts'

test('page index retains layout references without retaining body or table models', () => {
  const blocks = [
    { docxIndex: 0, type: 'paragraph', runs: [{ text: 'private body'.repeat(1000) }] },
    { docxIndex: 1, type: 'table', format: { pageBreakBefore: true }, table: { rows: ['private cell'] } },
  ]
  const index = indexDocxUnit('unit', blocks, new Map([[0, 25]]), new Map([[1, [
    { height: 10, header: true }, { height: 60 }, { height: 60 },
  ]]]), 100)
  assert.equal(index.length, 3)
  assert.deepEqual(index.map((item) => item.blockIndex), [0, 1, 1])
  assert.equal(index[1].breakBefore, true)
  assert.equal(index[2].breakBefore, false)
  assert.deepEqual(index[2].tablePage?.rows, [{ row: 0 }, { row: 2 }])
  assert.ok(!JSON.stringify(index).includes('private'))
  const before = paginateBlocks(index, 100)
  blocks.splice(0)
  assert.deepEqual(paginateBlocks(index, 100), before)
})

test('unmeasured images and tables retain useful fallback heights', () => {
  assert.deepEqual(indexDocxUnit('u', [{ type: 'image' }, { type: 'table' }], new Map(), new Map(), 1000)
    .map((item) => item.height), [240, 320])
})

test('remeasurement preserves unchanged index identity and replaces only its unit', async () => {
  const { replaceDocxUnitIndex } = await import('../src/web/docx-page-index.ts')
  const index = [
    { unitId: 'a', blockIndex: 0, height: 20 },
    { unitId: 'b', blockIndex: 0, height: 30 },
  ]
  assert.equal(replaceDocxUnitIndex(index, 'a', [{ ...index[0], height: 20.1 }]), index)
  assert.equal(replaceDocxUnitIndex(index, 'absent', []), index)
  const changed = replaceDocxUnitIndex(index, 'a', [{ ...index[0], height: 80 }])
  assert.equal(changed[0].height, 80)
  assert.equal(changed[1], index[1])
})

test('subpixel WebView geometry noise does not create an observer remeasurement loop', async () => {
  const { replaceDocxUnitIndex } = await import('../src/web/docx-page-index.ts')
  const original = [{ unitId: 'u', blockIndex: 0, height: 1000,
    geometry: { height: 1000, headerHeight: 20, cuts: [100, 200], forcedCuts: [],
      notes: [{ id: '1', kind: 'footnote' as const, top: -2, bottom: 8 }] } }]
  const noise = [{ ...original[0], geometry: { ...original[0].geometry, height: 1000.0002,
    cuts: [100.001, 200.001], notes: [{ id: '1', kind: 'footnote' as const, top: -1.999, bottom: 8.001 }] } }]
  assert.equal(replaceDocxUnitIndex(original, 'u', noise), original)
  const changed = [{ ...original[0], geometry: { ...original[0].geometry, cuts: [90, 200] } }]
  assert.notEqual(replaceDocxUnitIndex(original, 'u', changed), original)
})
