import React, { useLayoutEffect, useRef, useState } from 'react'
import { paintTableFlow } from './docx-table-flow-paint'
import type { TableFlowGeometry, TableFlowLayout } from './docx-table-flow'

interface Edge {
  side: 'top' | 'bottom'
  left: number
  width: number
  border: string
}

/** Reuse the table frame and explicit cell overrides, including authored nil borders. */
function edgeBorder(
  table: CSSStyleDeclaration,
  cell: HTMLTableCellElement,
  side: Edge['side'],
): string {
  const explicit = side === 'top' ? cell.style.borderTop : cell.style.borderBottom
  return (
    explicit ||
    table.getPropertyValue(side === 'top' ? '--doc-b-t' : '--doc-b-b').trim() ||
    table.getPropertyValue('--doc-b-h').trim() ||
    getComputedStyle(cell)[side === 'top' ? 'borderTop' : 'borderBottom']
  )
}

/** Paint continuation frames without changing the source table or its measured height. */
export function DocxFragmentSlice({
  from,
  to,
  pageWidth,
  table,
  children,
  flow,
  geometry,
}: {
  from: number
  to: number
  pageWidth: number
  table: boolean
  children: React.ReactNode
  flow?: TableFlowLayout
  geometry?: TableFlowGeometry
}) {
  const root = useRef<HTMLDivElement>(null)
  const source = useRef<HTMLDivElement>(null)
  const painted = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<Edge[]>([])
  useLayoutEffect(() => {
    const host = root.current!,
      content = source.current!
    if (!table) return
    let pending = 0
    const measure = () => {
      pending = 0
      let active = content
      if (flow && geometry && painted.current) {
        const original = content.querySelector<HTMLElement>('.doc-page')
        if (original) {
          const clone = original.cloneNode(true) as HTMLElement
          clone.removeAttribute('contenteditable')
          painted.current.replaceChildren(clone)
          paintTableFlow(clone, flow, geometry, from, to)
          active = painted.current
        }
      }
      const grid = active.querySelector<HTMLTableElement>('table.doc-table')
      const result: Edge[] = []
      if (grid) {
        const box = host.getBoundingClientRect(),
          gridBox = grid.getBoundingClientRect()
        // WebView may scale the page. Overlay coordinates stay in local CSS pixels.
        const scaleX = box.width / parseFloat(getComputedStyle(host).width) || 1
        const scaleY = box.height / (to - from) || 1
        const style = getComputedStyle(grid)
        for (const side of ['top', 'bottom'] as const) {
          const y = side === 'top' ? box.top : box.bottom
          if (y <= gridBox.top + 0.5 * scaleY || y >= gridBox.bottom - 0.5 * scaleY) continue
          const inside = y + (side === 'top' ? 0.75 : -0.75) * scaleY
          for (const row of grid.rows)
            for (const cell of row.cells) {
              const rect = cell.getBoundingClientRect()
              if (cell.hasAttribute('data-grid-gap') || rect.top > inside || rect.bottom < inside)
                continue
              result.push({
                side,
                left: (rect.left - box.left) / scaleX,
                width: rect.width / scaleX,
                border: edgeBorder(style, cell, side),
              })
            }
        }
      }
      setEdges((previous) =>
        JSON.stringify(previous) === JSON.stringify(result) ? previous : result,
      )
    }
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(schedule)
    resize.observe(content)
    resize.observe(host)
    const mutations = new MutationObserver(schedule)
    // Tiptap commits after mounting; observe only the source, never our decorations.
    mutations.observe(content, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class'],
    })
    measure()
    return () => {
      resize.disconnect()
      mutations.disconnect()
      cancelAnimationFrame(pending)
    }
  }, [from, to, table, flow, geometry])
  return (
    <div
      ref={root}
      className="viewer-doc-fragment-slice"
      style={{ height: to - from, clipPath: `inset(0 -${pageWidth}px)`, position: 'relative' }}
    >
      <div
        ref={source}
        data-docx-flow-source={flow ? '1' : undefined}
        aria-hidden={flow ? true : undefined}
        style={{
          position: flow ? 'absolute' : 'relative',
          top: -from,
          width: flow ? '100%' : undefined,
          visibility: flow ? 'hidden' : undefined,
        }}
      >
        {children}
      </div>
      {flow && (
        <div ref={painted} data-docx-flow-paint="1" style={{ position: 'relative', top: -from }} />
      )}
      {table &&
        edges.map((edge, index) => (
          <span
            key={index}
            aria-hidden="true"
            data-docx-table-edge={edge.side}
            style={{
              position: 'absolute',
              pointerEvents: 'none',
              left: edge.left,
              width: edge.width,
              ...(edge.side === 'top'
                ? { top: 0, borderTop: edge.border }
                : { bottom: 0, borderBottom: edge.border }),
            }}
          />
        ))}
    </div>
  )
}
