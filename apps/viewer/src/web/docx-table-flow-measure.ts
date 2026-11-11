import {
  cellLinesOf,
  createLineRectsCache,
} from '@genoffice/viewer-renderers/docs/renderer/pagination-lines'
import type {
  RowCellBox,
  TableRowBox,
} from '@genoffice/viewer-renderers/docs/renderer/pagination-types'
import type { TableFlowGeometry } from './docx-table-flow'

/** Store only numbers; the document's rows and rich content stay in the bounded unit cache. */
export function measureTableFlow(
  table: HTMLTableElement,
  model: any,
  compatibilityMode = 0,
): TableFlowGeometry | undefined {
  // Keep the existing geometry path for content whose fixed/vertical/nested boxes cannot reflow as lines.
  if (
    table.querySelector('.cell-clip,.cell-vert,table,sup[data-note-ref]') ||
    model?.rowHeightRules?.includes('exact')
  )
    return undefined
  const rectsOf = createLineRectsCache(),
    grid = table.getBoundingClientRect()
  const rows = [...table.rows],
    boxes: TableRowBox[] = []
  const groups: Array<{ start: number; end: number }> = []
  if (!rows.length) return undefined
  for (const [rowIndex, row] of rows.entries()) {
    const rowRect = row.getBoundingClientRect(),
      cells: RowCellBox[] = []
    for (const cell of row.cells) {
      const rect = cell.getBoundingClientRect(),
        style = getComputedStyle(cell),
        first = cell.firstElementChild
      const alignFrac =
        style.verticalAlign === 'middle' ? 0.5 : style.verticalAlign === 'bottom' ? 1 : 0
      const alignDy =
        alignFrac && first
          ? Math.max(
              0,
              first.getBoundingClientRect().top -
                rect.top -
                (parseFloat(getComputedStyle(first).marginTop) || 0) -
                parseFloat(style.paddingTop) -
                parseFloat(style.borderTopWidth),
            )
          : 0
      const offset = rect.top - rowRect.top - alignDy
      const paraIds = new Map<Element, number>()
      const entries = rectsOf(cell, 1).map((line) => {
        let child: Node = line.node
        while (child.parentNode && child.parentNode !== cell) child = child.parentNode
        const childIndex = [...cell.children].indexOf(child as Element)
        const para = (line.node instanceof Element ? line.node : line.node.parentElement)?.closest(
          'p,h1,h2,h3,h4,h5,h6',
        )
        if (para && !paraIds.has(para)) paraIds.set(para, paraIds.size)
        return {
          band: [line.offset + offset, line.bottom + offset] as [number, number],
          child: childIndex,
          para: para ? paraIds.get(para)! : -1 - childIndex,
        }
      })
      if (entries.some((entry) => entry.child < 0)) return undefined
      const childBox = [...cell.children].map((child) => {
        const box = child.getBoundingClientRect()
        return [box.top - rowRect.top - alignDy, box.bottom - rowRect.top - alignDy] as [
          number,
          number,
        ]
      })
      const box: RowCellBox = {
        ...cellLinesOf(entries),
        childBox,
        alignDy,
        alignFrac,
        childAfter: [...cell.children].map(
          (child) => parseFloat(getComputedStyle(child).marginBottom) || 0,
        ),
        childBefore: [...cell.children].map((child, i) =>
          i && cell.children[i - 1].classList.contains('sp-auto-a')
            ? 0
            : parseFloat(getComputedStyle(child).marginTop) || 0,
        ),
      }
      // A small merged region whose content spans its rows stays together. Large
      // regions fall back in the planner instead of dropping their continuation.
      if (cell.rowSpan > 1 && (box.lines.at(-1)?.[1] ?? 0) > rowRect.height + 0.5) {
        const end = Math.min(rows.length - 1, rowIndex + cell.rowSpan - 1)
        const previous = groups.find((group) => group.end >= rowIndex)
        if (previous) previous.end = Math.max(previous.end, end)
        else groups.push({ start: rowIndex, end })
      }
      cells.push(box)
    }
    boxes.push({
      height: rowRect.height,
      cells,
      cantSplit: model?.rowCantSplit?.[rowIndex] === true,
      isHeader: model?.repeatHeaderRows?.[rowIndex] === true,
      ...(model?.rowHeightRules?.[rowIndex] === 'atLeast' && model.rowHeightsTwips?.[rowIndex]
        ? { minHPx: model.rowHeightsTwips[rowIndex] / 15 }
        : {}),
    })
  }
  return {
    rows: boxes,
    top: rows[0].getBoundingClientRect().top - grid.top,
    bottom: grid.bottom - rows.at(-1)!.getBoundingClientRect().bottom,
    widow: compatibilityMode >= 15,
    groups,
  }
}
