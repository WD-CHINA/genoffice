import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  continuousDocxLayout,
  captureContinuousDocxAnchor,
  restoreContinuousDocxAnchor,
} from '../src/web/docx-continuous-layout.ts'
import { indexDocxUnit } from '../src/web/docx-page-index.ts'

test('a long table stays whole and source units join without page-height gaps', () => {
  const blocks = [
    { unitId: '0', blockIndex: 0, height: 40 },
    ...indexDocxUnit(
      '0',
      [{ type: 'table', docxIndex: 1 }],
      new Map(),
      new Map([
        [
          1,
          Array.from({ length: 100 }, () => ({
            height: 50,
            header: false,
            cantSplit: false,
            cellParagraphs: [1],
          })),
        ],
      ]),
      Infinity,
    ),
    { unitId: '1', blockIndex: 0, height: 60 },
  ]
  assert.equal(blocks.length, 3, 'paper height must not create table fragments')
  assert.deepEqual(continuousDocxLayout(blocks), {
    units: [
      { id: '0', top: 0, height: 5040 },
      { id: '1', top: 5040, height: 60 },
    ],
    height: 5100,
  })
})

test('a source anchor survives remeasurement above a long table', () => {
  const blocks = [
    { unitId: '0', blockIndex: 0, height: 80 },
    { unitId: '1', blockIndex: 0, height: 5000 },
  ]
  const anchor = captureContinuousDocxAnchor(blocks, 1330)!
  assert.deepEqual(anchor, { unitId: '1', blockIndex: 0, offset: 1250 })
  assert.equal(
    restoreContinuousDocxAnchor(anchor, [{ ...blocks[0], height: 120 }, blocks[1]]),
    1370,
  )
  assert.equal(
    restoreContinuousDocxAnchor({ ...anchor, sourceOffset: 2300, row: 10 }, blocks),
    2380,
  )
  assert.equal(restoreContinuousDocxAnchor({ ...anchor, unitId: 'missing' }, blocks), undefined)
})

test('empty content and scrolling before the body do not produce invalid saved anchors', () => {
  assert.deepEqual(continuousDocxLayout([]), { units: [], height: 0 })
  assert.equal(captureContinuousDocxAnchor([], 10), undefined)
  assert.equal(
    captureContinuousDocxAnchor([{ unitId: '0', blockIndex: 0, height: 40 }], -80)?.offset,
    0,
  )
})
