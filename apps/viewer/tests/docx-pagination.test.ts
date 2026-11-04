import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageTops, paginateBlocks, visiblePages } from '../src/web/docx-pagination.ts'

test('paginates by measured block height', () => {
  const pages = paginateBlocks([{ height: 400 }, { height: 400 }, { height: 400 }], 800)
  assert.deepEqual(
    pages.map((page) => [page.blockStart, page.blockEnd]),
    [
      [0, 2],
      [2, 3],
    ],
  )
})

test('honors breakBefore and keepWithNext', () => {
  const pages = paginateBlocks(
    [
      { height: 500 },
      { height: 200, keepWithNext: true },
      { height: 200 },
      { height: 100, breakBefore: true },
    ],
    800,
  )
  assert.deepEqual(
    pages.map((page) => [page.blockStart, page.blockEnd]),
    [
      [0, 1],
      [1, 3],
      [3, 4],
    ],
  )
})

test('gives an oversized block its own page', () => {
  const pages = paginateBlocks([{ height: 100 }, { height: 1200 }, { height: 100 }], 800)
  assert.deepEqual(
    pages.map((page) => [page.blockStart, page.blockEnd]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  )
})

test('visible page range includes overscan', () => {
  const pages = paginateBlocks(
    Array.from({ length: 20 }, () => ({ height: 400 })),
    800,
  )
  const tops = pageTops(pages)
  const range = visiblePages(
    tops,
    pages.map((page) => page.height),
    2000,
    800,
    2,
  )
  assert.ok(range.start <= 5)
  assert.equal(range.start, 0)
  assert.equal(range.end, 6)
  assert.ok(range.end - range.start < pages.length)
})
