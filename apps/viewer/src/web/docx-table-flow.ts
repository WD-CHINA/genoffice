import { planRowSplit } from '@genoffice/viewer-renderers/docs/renderer/pagination-slices'
import type {
  RowSplitRule,
  TableRowBox,
} from '@genoffice/viewer-renderers/docs/renderer/pagination-types'

export interface TableFlowGeometry {
  rows: TableRowBox[]
  top: number
  bottom: number
  widow: boolean
  groups?: Array<{ start: number; end: number }>
}
export interface TableFlowRow {
  top: number
  height: number
  rules: RowSplitRule[]
}
export interface TableFlowLayout {
  rows: TableFlowRow[]
  fragments: Array<{ from: number; to: number; headerHeight: number }>
  height: number
  startOnNewPage: boolean
}

/** Reuse the Word row splitter: each cell advances at its own legal line boundary. */
export function planTableFlow(
  flow: TableFlowGeometry,
  firstAvailable: number,
  pageHeight: number,
): TableFlowLayout | undefined {
  const headers = flow.rows.findIndex((row) => !row.isHeader)
  const headerCount = headers < 0 ? flow.rows.length : headers
  const headerHeight =
    flow.top + flow.rows.slice(0, headerCount).reduce((sum, row) => sum + row.height, 0)
  const repeat = headerCount ? headerHeight : 0
  if (pageHeight <= repeat + 1 || firstAvailable <= 0) return undefined
  const rows: TableFlowRow[] = [],
    fragments: TableFlowLayout['fragments'] = []
  let cursor = flow.top,
    start = 0,
    available = firstAvailable - flow.top,
    startOnNewPage = false
  let repeated = 0,
    placed = false
  const turn = (end: number) => {
    if (placed && end > start + 0.5) {
      fragments.push({ from: start, to: end, headerHeight: repeated })
      start = end
      repeated = repeat
      available = pageHeight - repeat
    } else {
      startOnNewPage = true
      available = pageHeight - flow.top
    }
    placed = false
    return available
  }
  for (const [index, row] of flow.rows.entries()) {
    const group = flow.groups?.find((group) => group.start === index)
    if (group) {
      const demand = flow.rows
        .slice(group.start, group.end + 1)
        .reduce((sum, row) => sum + row.height, 0)
      if (demand > pageHeight - repeat + 0.5) return undefined
      if (demand > available + 0.5) turn(cursor)
    }
    if (
      (row.cantSplit || row.isHeader || (row.minHPx ?? 0) > available) &&
      row.height > available + 0.5 &&
      placed
    )
      turn(cursor)
    const top = cursor
    let target = row.height,
      rules: RowSplitRule[] = []
    if (row.height > available + 0.5 && !row.cantSplit && !row.isHeader && row.cells?.length) {
      const split = () =>
        planRowSplit(
          row,
          available,
          pageHeight - repeat,
          (_used, y) => {
            placed = true
            return turn(top + y)
          },
          flow.widow,
        )
      let plan = split()
      if (plan === 'nofit' && available < pageHeight - repeat - 0.5) {
        turn(cursor)
        plan = split()
      }
      if (!plan || plan === 'nofit') return undefined
      if (!plan.rules.length && plan.lastFragment > available + 0.5) {
        if (plan.lastFragment > pageHeight - repeat + 0.5) return undefined
        turn(cursor)
        plan = split()
        if (!plan || plan === 'nofit') return undefined
      }
      target = plan.target
      rules = plan.rules.map((rule) => ({ ...rule, from: top + rule.from }))
      available -= plan.lastFragment
    } else {
      if (row.height > available + 0.5) {
        if (row.height > pageHeight - (index >= headerCount ? repeat : 0) + 0.5) return undefined
        turn(cursor)
      }
      available -= row.height
    }
    rows.push({ top, height: target, rules })
    cursor = top + target
    placed = true
  }
  cursor += flow.bottom
  if (cursor > start + 0.5) fragments.push({ from: start, to: cursor, headerHeight: repeated })
  return { rows, fragments, height: cursor, startOnNewPage }
}
