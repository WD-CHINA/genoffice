export interface TableRowLayout {
  /** Measured row height in CSS pixels. */
  height: number
  /** w:cantSplit: the row may not be broken across pages. */
  cantSplit?: boolean
  /** w:tblHeader: this row repeats at the top of each page (leading rows only). */
  header?: boolean
  /** Paragraph count in each cell, used to split a breakable row. */
  cellParagraphs?: number[]
}

export interface TablePageRow {
  row: number
  /** Paragraph range for a row split across pages; absent for a whole row. */
  part?: { start: number; end: number }
}

export interface TablePage {
  rows: TablePageRow[]
  height: number
  /** True when a row could not fit even on an empty page. */
  overflow?: boolean
}

interface PendingRow {
  row: number
  start: number
  end: number
  height: number
  cantSplit: boolean
  paragraphCount: number
}

/**
 * Row-level table pagination.
 *
 * Leading `tblHeader` rows repeat on every page. A `cantSplit` row is kept
 * whole; a breakable row may be split at a paragraph boundary when it crosses
 * a page boundary. This is the layout half of Gate B.4; rendering a split row
 * is the caller's job.
 */
export function paginateTableRows(
  rows: readonly TableRowLayout[],
  pageHeight: number,
  options: { headerRows?: number } = {},
): TablePage[] {
  if (pageHeight <= 0) throw new Error('pageHeight must be positive')
  const headerCount = Math.min(options.headerRows ?? 0, rows.length)
  const headerRows = rows.slice(0, headerCount)
  const headerHeight = headerRows.reduce((total, row) => total + row.height, 0)
  const pages: TablePage[] = []
  let page: TablePage = { rows: [], height: 0 }

  const startPage = () => {
    page = { rows: [], height: headerHeight }
    for (let index = 0; index < headerCount; index++) page.rows.push({ row: index })
  }
  const flush = (overflow = false) => {
    if (page.rows.length <= headerCount && !overflow) return
    page.overflow = overflow || page.overflow
    pages.push(page)
    startPage()
  }

  const pending: PendingRow[] = rows.slice(headerCount).map((row, offset) => ({
    row: headerCount + offset,
    start: 0,
    end: Math.max(1, ...(row.cellParagraphs || [1])),
    height: row.height,
    cantSplit: row.cantSplit === true,
    paragraphCount: Math.max(1, ...(row.cellParagraphs || [1])),
  }))

  startPage()
  while (pending.length) {
    const row = pending[0]
    const remaining = pageHeight - page.height
    if (row.height <= remaining) {
      page.rows.push({
        row: row.row,
        ...(row.start > 0 || row.end < row.paragraphCount
          ? { part: { start: row.start, end: row.end } }
          : {}),
      })
      page.height += row.height
      pending.shift()
      continue
    }
    if (page.rows.length > headerCount) {
      flush()
      continue
    }
    if (row.cantSplit) {
      // Keep the row whole even when it overflows; Word grows the row instead
      // of dropping content.
      page.rows.push({ row: row.row })
      page.height += row.height
      pending.shift()
      flush(page.height > pageHeight)
      continue
    }
    // Split a breakable row at a paragraph boundary that fits the remaining space.
    const total = row.end - row.start
    if (total <= 1) {
      page.rows.push({ row: row.row })
      page.height += row.height
      pending.shift()
      flush(page.height > pageHeight)
      continue
    }
    const fraction = Math.max(0.05, Math.min(0.95, remaining / row.height))
    const take = Math.max(1, Math.min(total - 1, Math.floor(total * fraction)))
    const used = (row.height * take) / total
    page.rows.push({ row: row.row, part: { start: row.start, end: row.start + take } })
    page.height += used
    pending[0] = {
      ...row,
      start: row.start + take,
      height: row.height - used,
    }
    flush()
  }
  flush()
  return pages
}
