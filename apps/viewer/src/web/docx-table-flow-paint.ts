import type { TableFlowGeometry, TableFlowLayout } from './docx-table-flow'

/** Apply the shared row-split rules to a read-only clone; the source editor remains untouched. */
export function paintTableFlow(
  root: HTMLElement,
  flow: TableFlowLayout,
  geometry: TableFlowGeometry,
  from: number,
  to: number,
): void {
  const table = root.querySelector<HTMLTableElement>('table.doc-table')
  if (!table) return
  const rows = [...table.rows]
  flow.rows.forEach((row, index) => {
    if (row.height > geometry.rows[index].height + 0.1) rows[index].style.height = `${row.height}px`
  })
  const scaleY =
    root.getBoundingClientRect().height / parseFloat(getComputedStyle(root).height) || 1
  // Read positions after row fills: a vertical merge's centering changes when its row grows.
  for (const [index, row] of rows.entries()) {
    const placed = flow.rows[index],
      measured = geometry.rows[index]
    if (!placed || !measured) continue
    const rules = placed.rules.filter((rule) => rule.from >= from - 0.5 && rule.from < to - 0.5)
    for (const [cellIndex, cell] of [...row.cells].entries()) {
      const box = measured.cells?.[cellIndex]
      if (!box) continue
      const children = [...cell.children] as HTMLElement[]
      const cellRules = rules.filter((rule) => rule.cell === cellIndex)
      const spanEnd = flow.rows[Math.min(rows.length - 1, index + cell.rowSpan - 1)]
      const spansPage =
        cell.rowSpan > 1 && (placed.top < from - 0.5 || spanEnd.top + spanEnd.height > to + 0.5)
      if (spansPage && placed.top + placed.height <= from + 0.5) {
        children.forEach((child) => {
          child.style.visibility = 'hidden'
          child.setAttribute('aria-hidden', 'true')
        })
        continue
      }
      if (!cellRules.length && !spansPage) continue
      const first = children[0],
        rect = cell.getBoundingClientRect(),
        css = getComputedStyle(cell)
      const currentAlign =
        box.alignFrac && first
          ? Math.max(
              0,
              (first.getBoundingClientRect().top - rect.top) / scaleY -
                (parseFloat(getComputedStyle(first).marginTop) || 0) -
                parseFloat(css.paddingTop) -
                parseFloat(css.borderTopWidth),
            )
          : 0
      const correction = box.alignDy - currentAlign
      children.forEach((child) => {
        if (Math.abs(correction) > 0.05) child.style.transform = `translateY(${correction}px)`
      })
      for (const rule of cellRules) {
        const targets = rule.tail
          ? children.slice(rule.child)
          : children.slice(rule.child, rule.child + 1)
        for (const child of targets) {
          if (rule.hide) {
            child.style.visibility = 'hidden'
            child.setAttribute('aria-hidden', 'true')
          }
          if (rule.dy !== undefined) child.style.transform = `translateY(${rule.dy + correction}px)`
          if (rule.clipTop !== undefined || rule.clipBottom !== undefined)
            child.style.clipPath = `inset(${rule.clipTop ?? 0}px 0 ${rule.clipBottom ?? 0}px 0)`
        }
      }
      if (
        spansPage &&
        box.lines.length &&
        placed.top >= from - 0.5 &&
        box.lines.at(-1)![1] <= Math.min(to, placed.top + placed.height) - placed.top + 0.5
      ) {
        const bottom = box.lines.at(-1)![1]
        const dy =
          -currentAlign +
          box.alignFrac *
            Math.max(0, Math.min(to, spanEnd.top + spanEnd.height) - placed.top - bottom)
        children.forEach((child) => {
          child.style.transform = `translateY(${dy}px)`
        })
      }
    }
  }
}
