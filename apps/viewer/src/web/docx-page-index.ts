import { paginateTableRows, type TablePage, type TableRowLayout } from './docx-table-pagination'

/** Durable layout metadata only: never retain text, images or table cell models here. */
export interface DocxPageBlock {
  unitId: string
  blockIndex: number
  height: number
  breakBefore?: boolean
  tablePage?: TablePage
  headerRows?: number
}

/** Preserve identity for unchanged layout, avoiding observer/re-render feedback loops. */
export function replaceDocxUnitIndex(
  previous: DocxPageBlock[], unitId: string, replacement: DocxPageBlock[],
): DocxPageBlock[] {
  const current = previous.filter((block) => block.unitId === unitId)
  if (!current.length) return previous
  if (current.length === replacement.length && current.every((block, index) => {
    const next = replacement[index]
    return block.blockIndex === next.blockIndex && Math.abs(block.height - next.height) < 0.5 &&
      block.breakBefore === next.breakBefore && block.headerRows === next.headerRows &&
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
  contentHeight: number,
): DocxPageBlock[] {
  return blocks.flatMap((block, blockIndex): DocxPageBlock[] => {
    const base = { unitId, blockIndex, breakBefore: block.format?.pageBreakBefore === true }
    const tableRows = rows.get(block.docxIndex)
    if (block.type === 'table' && tableRows?.length) {
      let headerRows = 0
      while (tableRows[headerRows]?.header) headerRows++
      return paginateTableRows(tableRows, contentHeight, { headerRows }).map((tablePage, index) => ({
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
