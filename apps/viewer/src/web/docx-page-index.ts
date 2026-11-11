import type { DocxBlockGeometry, DocxClip } from './docx-fragments'
import { paginateTableRows, type TablePage, type TableRowLayout } from './docx-table-pagination'
import type { TableFlowLayout } from './docx-table-flow'

/** Durable layout metadata only: never retain text, images or table cell models here. */
export interface DocxPageBlock {
  unitId: string
  blockIndex: number
  docxIndex?: number
  height: number
  breakBefore?: boolean
  columnBreakBefore?: boolean
  keepWithNext?: boolean
  tablePage?: TablePage
  headerRows?: number
  geometry?: DocxBlockGeometry
  clip?: DocxClip
  keepLines?: boolean
  widowControl?: boolean
  noteKey?: string
  tableFlow?: TableFlowLayout
}

/** Numeric cell metadata is subject to the same translated-layer noise as row cuts. */
function sameFlowGeometry(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < .1
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => sameFlowGeometry(value, b[index]))
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameFlowGeometry(left[key], right[key]))
}

/** Translated WebView layers introduce subpixel float noise; it must not trigger another layout pass. */
function sameGeometry(a: DocxBlockGeometry | undefined, b: DocxBlockGeometry | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const close = (x = 0, y = 0) => Math.abs(x - y) < .1
  const points = (x: readonly number[] = [], y: readonly number[] = []) => x.length === y.length && x.every((value, i) => close(value, y[i]))
  return close(a.height, b.height) && close(a.headerHeight, b.headerHeight) && points(a.cuts, b.cuts) && points(a.forcedCuts, b.forcedCuts)
    && sameFlowGeometry(a.tableFlow, b.tableFlow)
    && a.notes.length === b.notes.length && a.notes.every((note, index) => {
      const next = b.notes[index]
      return note.id === next.id && note.kind === next.kind && close(note.top, next.top) && close(note.bottom, next.bottom)
    })
}

/** Preserve identity for unchanged layout, avoiding observer/re-render feedback loops. */
export function replaceDocxUnitIndex(
  previous: DocxPageBlock[], unitId: string, replacement: DocxPageBlock[],
): DocxPageBlock[] {
  const current = previous.filter((block) => block.unitId === unitId)
  if (!current.length) return previous
  if (current.length === replacement.length && current.every((block, index) => {
    const next = replacement[index]
    return block.blockIndex === next.blockIndex && block.docxIndex === next.docxIndex && Math.abs(block.height - next.height) < 0.5 &&
      block.columnBreakBefore === next.columnBreakBefore && block.keepWithNext === next.keepWithNext &&
      block.breakBefore === next.breakBefore && block.headerRows === next.headerRows &&
      sameGeometry(block.geometry, next.geometry) &&
      JSON.stringify(block.tablePage && { ...block.tablePage, height: 0 }) ===
      JSON.stringify(next.tablePage && { ...next.tablePage, height: 0 })
  })) return previous
  let inserted = false
  return previous.flatMap((block) => {
    if (block.unitId !== unitId) return [block]
    if (inserted) return []
    inserted = true
    return replacement
  })
}

export function indexDocxUnit(
  unitId: string,
  blocks: readonly any[],
  heights: ReadonlyMap<number, number>,
  rows: ReadonlyMap<number, TableRowLayout[]>,
  contentHeight: number | ((block: any) => number),
  geometries?: ReadonlyMap<number, DocxBlockGeometry>,
): DocxPageBlock[] {
  return blocks.flatMap((block, blockIndex): DocxPageBlock[] => {
    const base = { unitId, blockIndex, docxIndex: block.docxIndex,
      breakBefore: block.format?.pageBreakBefore === true || block.format?.effective?.pageBreakBefore === true,
      columnBreakBefore: /<w:br\b[^>]*w:type=["']column["']/.test(block.originalXml ?? ''),
      keepWithNext: block.format?.keepNext === true || block.format?.effective?.keepNext === true }
    if (block.hidden) return [{ ...base, height: 0 }]
    const geometry = geometries?.get(block.docxIndex)
    if (geometry) return [{ ...base, geometry,
      height: geometry.height ?? heights.get(block.docxIndex) ?? rows.get(block.docxIndex)?.reduce((sum, row) => sum + row.height, 0) ?? 24,
      keepLines: block.format?.keepLines ?? block.format?.effective?.keepLines,
      widowControl: block.format?.widowControl ?? block.format?.effective?.widowControl ?? true }]
    const tableRows = rows.get(block.docxIndex)
    if (block.type === 'table' && tableRows?.length) {
      let headerRows = 0
      while (tableRows[headerRows]?.header) headerRows++
      return paginateTableRows(tableRows, typeof contentHeight === 'number' ? contentHeight : contentHeight(block), { headerRows }).map((tablePage, index) => ({
        ...base,
        // A source page break applies once, rather than before every table fragment.
        breakBefore: index === 0 && base.breakBefore,
        height: Math.max(1, tablePage.height),
        tablePage,
        headerRows,
      }))
    }
    const text = (block.runs || []).map((run: any) => run.text || '').join('')
    const estimated = block.type === 'table' ? 320 : block.type === 'image' ? 240
      : Math.max(24, 22 + Math.ceil(text.length / 70) * 20)
    return [{ ...base, height: heights.get(block.docxIndex) ?? estimated }]
  })
}
