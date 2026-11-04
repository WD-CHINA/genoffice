import assert from 'node:assert/strict'
import { test } from 'node:test'
import { paginateTableRows } from '../src/web/docx-table-pagination.ts'

test('paginates rows and repeats leading header rows', () => {
  const pages = paginateTableRows(
    [
      { height: 40, header: true },
      { height: 100 },
      { height: 100 },
      { height: 100 },
      { height: 100 },
      { height: 100 },
    ],
    300,
    { headerRows: 1 },
  )
  assert.equal(pages.length, 3)
  assert.deepEqual(
    pages[0].rows.map((row) => row.row),
    [0, 1, 2],
  )
  assert.deepEqual(
    pages[1].rows.map((row) => row.row),
    [0, 3, 4],
  )
  assert.deepEqual(
    pages[2].rows.map((row) => row.row),
    [0, 5],
  )
})

test('keeps cantSplit rows whole and moves them to the next page', () => {
  const pages = paginateTableRows(
    [{ height: 40, header: true }, { height: 200 }, { height: 120, cantSplit: true }],
    300,
    { headerRows: 1 },
  )
  assert.deepEqual(
    pages[0].rows.map((row) => row.row),
    [0, 1],
  )
  assert.deepEqual(
    pages[1].rows.map((row) => row.row),
    [0, 2],
  )
})

test('splits a breakable row at a paragraph boundary', () => {
  const pages = paginateTableRows(
    [
      { height: 40, header: true },
      { height: 320, cellParagraphs: [10, 10] },
    ],
    300,
    { headerRows: 1 },
  )
  assert.equal(pages.length, 2)
  assert.ok(pages[0].rows[1].part)
  assert.ok(pages[1].rows[1].part)
  assert.equal(pages[0].rows[1].part!.start, 0)
  assert.equal(pages[1].rows[1].part!.end, 10)
})

test('marks an oversized cantSplit row as overflow', () => {
  const pages = paginateTableRows([{ height: 400, cantSplit: true }], 300)
  assert.equal(pages.length, 1)
  assert.equal(pages[0].overflow, true)
})
