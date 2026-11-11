import assert from 'node:assert/strict'
import test from 'node:test'
import { sectionFromSectPr } from '@genoffice/docx-engine'
import { layoutSectionBlocks } from '../src/web/docx-section-layout'
import type { RemoteNote } from '../src/web/docx-notes'
import { splitClip } from '../src/web/docx-fragments'

const context = () => ({
  sections: [sectionFromSectPr('', 0, 10)],
  hfParts: {},
  footnotes: [],
  endnotes: [],
  noteNumbers: {},
  evenAndOddHeaders: false,
  mirrorMargins: false,
})
const block = (height: number) => ({
  unitId: '0',
  blockIndex: 0,
  docxIndex: 0,
  height,
  geometry: {
    cuts: Array.from({ length: Math.ceil(height / 20) - 1 }, (_, index) => (index + 1) * 20),
    notes: [],
  },
})

test('long paragraphs cover their entire measured height with physical pages and exact seams', () => {
  const source = block(2400)
  const result = layoutSectionBlocks([source], context())
  assert.equal(result.pages.length, 3)
  assert.equal(result.blocks[0].clip?.from, 0)
  assert.equal(result.blocks.at(-1)?.clip?.to, 2400)
  for (let i = 1; i < result.blocks.length; i++)
    assert.equal(result.blocks[i - 1].clip?.to, result.blocks[i].clip?.from)
  assert.ok(
    result.pages.every(
      (page) => page.height <= page.pageHeight - page.paddingTop - page.paddingBottom,
    ),
  )
  assert.equal(source.height, 2400)
  assert.ok(!('clip' in source), 'source index must remain immutable')
})

test('paragraphs use remaining space and carry only the tail onto the next page', () => {
  const first = { unitId: '0', blockIndex: 0, docxIndex: 0, height: 780 }
  const second = { ...block(200), blockIndex: 1, docxIndex: 1 }
  const result = layoutSectionBlocks([first, second], context())
  assert.equal(result.pages.length, 2)
  assert.equal(result.blocks[1].clip?.to, 80)
  assert.equal(result.blocks[2].clip?.from, 80)
})

test('footnote body reserves page space and a long note continues without losing its tail', () => {
  const source = block(820)
  source.geometry.notes.push({ id: '1', kind: 'footnote', top: -4, bottom: 8 } as never)
  const note: RemoteNote = {
    id: '1',
    key: '0:footnote:1',
    kind: 'footnote',
    no: 1,
    text: 'note',
    height: 1800,
    cuts: Array.from({ length: 89 }, (_, index) => (index + 1) * 20),
  }
  const result = layoutSectionBlocks([source], context(), new Map(), new Map([[note.key, note]]))
  const parts = result.pages.flatMap((page) => page.notes ?? [])
  assert.equal(parts[0].from, 0)
  assert.equal(parts.at(-1)?.to, 1800)
  assert.equal(
    parts.reduce((sum, part) => sum + part.to - part.from, 0),
    1800,
  )
  assert.ok(
    result.pages.every(
      (page) =>
        page.height + (page.noteHeight ?? 0) <=
        page.pageHeight - page.paddingTop - page.paddingBottom,
    ),
  )
})

test('table continuation repeats measured headers while preserving the original source interval', () => {
  const source = block(1800)
  source.geometry = { ...source.geometry, headerHeight: 60 } as typeof source.geometry
  const result = layoutSectionBlocks([source], context())
  assert.ok(result.blocks.length > 2)
  assert.equal(result.blocks.at(-1)?.clip?.to, 1800)
  assert.ok(
    result.blocks.slice(1).every((item) => item.height === item.clip!.to - item.clip!.from + 60),
  )
  assert.deepEqual(splitClip({ from: 20, to: 200 }, 100), [
    { from: 20, to: 100 },
    { from: 100, to: 200 },
  ])
})

test('remeasuring a long paragraph restores the source slice instead of jumping to its first page', async () => {
  const { captureDocxAnchor, restoreDocxAnchor } = await import('../src/web/docx-scroll-anchor')
  const result = layoutSectionBlocks([block(2400)], context())
  const tops = result.pages.map((page, i) => i * (page.pageHeight + 24))
  const scrollTop = tops[1] + result.pages[1].paddingTop + 50
  const anchor = captureDocxAnchor(result.blocks, result.pages, tops, scrollTop, 0)!
  assert.ok(anchor.sourceOffset! > 800)
  assert.equal(restoreDocxAnchor(anchor, result.blocks, result.pages, tops, 0), scrollTop)
})

test('measured keep-with-next chains move together before paragraph line splitting', () => {
  const first = { unitId: '0', blockIndex: 0, docxIndex: 0, height: 650 }
  const a = { ...block(100), blockIndex: 1, docxIndex: 1, keepWithNext: true }
  const b = { ...block(100), blockIndex: 2, docxIndex: 2, keepWithNext: true }
  const c = { ...block(100), blockIndex: 3, docxIndex: 3 }
  const result = layoutSectionBlocks([first, a, b, c], context())
  assert.equal(result.pages.length, 2)
  assert.equal(result.pages[0].blockEnd, 1)
  assert.equal(result.pages[1].blockStart, 1)
  assert.equal(result.blocks.length, 4)
})
