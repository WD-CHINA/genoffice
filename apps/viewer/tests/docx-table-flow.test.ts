import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planTableFlow, type TableFlowGeometry } from '../src/web/docx-table-flow'
import type { RowCellBox } from '@genoffice/viewer-renderers/docs/renderer/pagination-types'

function cell(count: number, pitch: number, alignFrac = 0): RowCellBox {
  return {
    lines: Array.from({ length: count }, (_, i) => [i * pitch, (i + 1) * pitch]),
    childOf: Array(count).fill(0),
    paraOf: Array(count).fill(0),
    childBox: [[0, count * pitch]],
    alignFrac,
    alignDy: alignFrac * (240 - count * pitch),
  }
}
const geometry = (cells: RowCellBox[], height = 240): TableFlowGeometry => ({
  top: 0,
  bottom: 0,
  widow: false,
  rows: [{ height, cells }],
})

test('cells with different line pitches advance independently and use the remaining page', () => {
  const flow = planTableFlow(geometry([cell(12, 20), cell(10, 24)]), 100, 100)!
  assert.deepEqual(
    flow.fragments.map((part) => [part.from, part.to]),
    [
      [0, 100],
      [100, 200],
      [200, 248],
    ],
  )
  const clips = flow.rows[0].rules.filter(
    (rule) => rule.from === 0 && rule.clipBottom !== undefined,
  )
  assert.equal(clips.length, 2)
  assert.notEqual(clips[0].clipBottom, clips[1].clipBottom)
})

test('short middle/bottom content is aligned in its first fragment and hidden thereafter', () => {
  const flow = planTableFlow(geometry([cell(12, 20), cell(1, 20, 0.5), cell(1, 20, 1)]), 100, 100)!
  const rules = flow.rows[0].rules
  assert.ok(rules.some((rule) => rule.cell === 1 && rule.from === 0 && rule.dy === -70))
  assert.ok(rules.some((rule) => rule.cell === 2 && rule.from === 0 && rule.dy === -140))
  for (const index of [1, 2])
    assert.ok(rules.some((rule) => rule.cell === index && rule.from === 100 && rule.hide))
})

test('indivisible rows move whole and repeated headers reserve actual height on each continuation', () => {
  const source: TableFlowGeometry = {
    top: 0,
    bottom: 0,
    widow: false,
    rows: [
      { height: 20, isHeader: true, cells: [cell(1, 20)] },
      { height: 240, cells: [cell(12, 20), cell(10, 24)] },
      { height: 45, cantSplit: true, cells: [cell(1, 45)] },
    ],
  }
  const flow = planTableFlow(source, 100, 100)!
  assert.ok(flow.fragments.slice(1).every((part) => part.headerHeight === 20))
  assert.ok(flow.fragments.every((part) => part.to - part.from + part.headerHeight <= 100))
  assert.equal(flow.rows.at(-1)!.rules.length, 0)
  assert.equal(source.rows[1].height, 240)
})


test('small merged regions move together and oversized regions retain the fallback path', () => {
  const source: TableFlowGeometry = { top: 0, bottom: 0, widow: false, groups: [{ start: 1, end: 2 }], rows: [
    { height: 60 }, { height: 30 }, { height: 30 },
  ] }
  const flow = planTableFlow(source, 100, 100)!
  assert.deepEqual(flow.fragments.map(part => [part.from, part.to]), [[0, 60], [60, 120]])
  assert.equal(flow.rows[1].rules.length, 0)
  assert.equal(planTableFlow({ ...source, groups: [{ start: 0, end: 2 }] }, 100, 100), undefined)
})
