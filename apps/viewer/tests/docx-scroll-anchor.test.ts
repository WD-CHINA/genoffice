import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureDocxAnchor, restoreDocxAnchor } from '../src/web/docx-scroll-anchor.ts'
import { paginateBlocks } from '../src/web/docx-pagination.ts'
import type { DocxPageBlock } from '../src/web/docx-page-index.ts'

test('anchor follows the source block when preceding content moves it onto another page', () => {
  const blocks: DocxPageBlock[] = [0, 1, 2].map((blockIndex) => ({ unitId: 'u', blockIndex, height: 40 }))
  const pages = paginateBlocks(blocks, 100)
  const anchor = captureDocxAnchor(blocks, pages, [0, 120], 65, 10)!
  assert.equal(anchor.blockIndex, 1)
  assert.equal(anchor.offset, 15)
  const updated = blocks.map((block) => ({ ...block, height: block.blockIndex === 0 ? 90 : 40 }))
  assert.equal(restoreDocxAnchor(anchor, updated, paginateBlocks(updated, 100), [0, 120], 10), 145)
})

test('table anchor avoids repeated headers and follows a split row paragraph', () => {
  const blocks: DocxPageBlock[] = [{ unitId: 'u', blockIndex: 0, height: 90, headerRows: 1,
    tablePage: { height: 90, rows: [{ row: 0 }, { row: 2, part: { start: 3, end: 6 } }] } }]
  const anchor = captureDocxAnchor(blocks, paginateBlocks(blocks, 100), [0], 20, 10)!
  assert.equal(anchor.row, 2)
  assert.equal(anchor.paragraph, 3)
  const updated: DocxPageBlock[] = [
    { ...blocks[0], tablePage: { height: 90, rows: [{ row: 0 }, { row: 2, part: { start: 0, end: 3 } }] } },
    { ...blocks[0], tablePage: { height: 90, rows: [{ row: 0 }, { row: 2, part: { start: 3, end: 5 } }] } },
  ]
  assert.equal(restoreDocxAnchor(anchor, updated, paginateBlocks(updated, 100), [0, 120], 10), 140)
})

test('empty or replaced documents have no restorable anchor', () => {
  assert.equal(captureDocxAnchor([], [], [], 0, 10), undefined)
  assert.equal(restoreDocxAnchor({ unitId: 'old', blockIndex: 0, offset: 0 }, [], [], [], 10), undefined)
})
