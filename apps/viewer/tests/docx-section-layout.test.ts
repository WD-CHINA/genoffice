import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sectionFromSectPr, type DocxReadingContext } from '@genoffice/docx-engine'
import { paginateSectionBlocks, hfHeightKey } from '../src/web/docx-section-layout.ts'
import { restoreDocxAnchor } from '../src/web/docx-scroll-anchor.ts'

const section = (first: number, last: number, type = 'nextPage', extra = '') => sectionFromSectPr(
  `<w:sectPr><w:type w:val="${type}"/><w:pgSz w:w="6000" w:h="6000"/><w:pgMar w:top="300" w:bottom="300" w:left="300" w:right="300"/>${extra}</w:sectPr>`, first, last,
)
const context = (sections: DocxReadingContext['sections']): DocxReadingContext => ({ sections, hfParts: {}, footnotes: [], endnotes: [], noteNumbers: {}, mirrorMargins: false, evenAndOddHeaders: false })
const block = (index: number, height: number) => ({ unitId: index < 2 ? '0' : '1', blockIndex: index % 2, docxIndex: index, height })

test('section paper geometry and explicit next-page breaks survive chunk boundaries', () => {
  const second = section(2, 3)
  second.settings.pageWidth = 9000
  const pages = paginateSectionBlocks([0, 1, 2, 3].map((i) => block(i, 100)), context([section(0, 1), second]))
  assert.deepEqual(pages.map((page) => [page.blockStart, page.blockEnd, page.width]), [[0, 2, 400], [2, 4, 600]])
})

test('continuous sections share a page and two columns keep disjoint source ranges', () => {
  const two = section(2, 5, 'continuous', '<w:cols w:num="2" w:space="300"/>')
  const pages = paginateSectionBlocks([block(0, 50), block(1, 50), ...[2, 3, 4, 5].map((i) => block(i, 100))], context([section(0, 1), two]))
  assert.equal(pages.length, 1)
  assert.equal(pages[0].regions.length, 2)
  assert.deepEqual(pages[0].regions[1].columns.map((column) => [column.blockStart, column.blockEnd]), [[2, 4], [4, 6]])
  const top = restoreDocxAnchor({ unitId: '1', blockIndex: 0, offset: 0 }, [block(0, 50), block(1, 50), block(2, 100), block(3, 100), { ...block(4, 100), unitId: '2' }, { ...block(5, 100), unitId: '2' }], pages, [0], 20)
  assert.equal(top, 120)
})

test('header variants inherit across sections and reserve space without clipping body', () => {
  const first = section(0, 0, 'nextPage', '<w:headerReference w:type="default" r:id="h"/>')
  const second = section(1, 3, 'nextPage', '<w:titlePg/><w:headerReference w:type="first" r:id="first"/>')
  const heights = new Map([[hfHeightKey('first', 360), 90], [hfHeightKey('h', 360), 30]])
  const pages = paginateSectionBlocks([block(0, 100), block(1, 200), block(2, 200), block(3, 100)], context([first, second]), heights)
  assert.equal(pages[1].headerId, 'first')
  assert.equal(pages[1].paddingTop, 138)
  assert.equal(pages[2].headerId, 'h')
  assert.equal(pages[2].paddingTop, 78)
})

test('keep-with-next works across units and odd-page sections insert a blank page', () => {
  const blocks = [block(0, 300), { ...block(1, 50), keepWithNext: true }, block(2, 50), block(3, 10)]
  const pages = paginateSectionBlocks(blocks, context([section(0, 2), section(3, 3, 'oddPage')]))
  assert.deepEqual(pages.map((page) => [page.blockStart, page.blockEnd]), [[0, 1], [1, 3], [3, 4]])
  const parity = paginateSectionBlocks([block(0, 20), block(1, 20)], context([section(0, 0), section(1, 1, 'oddPage')]))
  assert.deepEqual(parity.map((page) => [page.blockStart, page.blockEnd]), [[0, 1], [1, 1], [1, 2]])
})

test('a short final column set balances into both columns instead of leaving the second empty', () => {
  const model = context([section(0, 5, 'nextPage', '<w:cols w:num="2" w:space="300"/>')])
  const pages = paginateSectionBlocks([0, 1, 2, 3, 4, 5].map((index) => block(index, 30)), model)
  assert.equal(pages.length, 1)
  assert.deepEqual(pages[0].regions[0].columns.map((column) => [column.blockStart, column.blockEnd, column.height]), [[0, 3, 90], [3, 6, 90]])
})
