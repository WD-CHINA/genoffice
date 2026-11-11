import {
  createLineRectsCache,
  cellCutYs,
  lineBreakBoundaries,
} from '@genoffice/viewer-renderers/docs/renderer/pagination-lines'

/** Numeric geometry only: never keep DOM nodes or document text in the page index. */
export interface DocxBlockGeometry {
  cuts: number[]
  height?: number
  headerHeight?: number
  notes: Array<{ id: string; kind: 'footnote' | 'endnote'; top: number; bottom: number }>
  forcedCuts?: number[]
}
export interface DocxClip {
  from: number
  to: number
  headerHeight?: number
}

export function measureBlockGeometry(
  element: HTMLElement,
  height: number,
  table = false,
): DocxBlockGeometry {
  const rect = element.getBoundingClientRect()
  const rectsOf = createLineRectsCache()
  const lines = rectsOf(element, 1)
  const cuts = lineBreakBoundaries(lines)
  const rows = table
    ? [...(element.querySelector('table') ?? (element as HTMLTableElement)).rows]
    : []
  for (const row of rows) {
    const bottom = row.getBoundingClientRect().bottom - rect.top
    if (!lines.some((line) => line.offset < bottom - 0.5 && line.bottom > bottom + 0.5))
      cuts.push(bottom)
  }
  const forcedCuts = [...element.querySelectorAll<HTMLElement>('.doc-page-br')]
    .map((node) => node.getBoundingClientRect().top - rect.top)
    .filter((top) => top > 0.5 && top < height - 0.5)
  return {
    height,
    cuts: [
      ...new Set(
        cuts
          .filter((cut) => cut > 0.5 && cut < height - 0.5)
          .map((cut) => Math.round(cut * 100) / 100),
      ),
    ].sort((a, b) => a - b),
    forcedCuts,
    notes: [...element.querySelectorAll<HTMLElement>('sup[data-note-ref]')].map((node) => ({
      id: node.dataset.noteRef!,
      kind: node.dataset.noteKind === 'endnote' ? 'endnote' : 'footnote',
      top: node.getBoundingClientRect().top - rect.top,
      bottom: node.getBoundingClientRect().bottom - rect.top,
    })),
  }
}

/** All adjacent slices use the same exact boundary, preserving every painted pixel. */
export function splitClip(clip: DocxClip, cut: number): [DocxClip, DocxClip] {
  if (!(cut > clip.from && cut < clip.to)) throw new Error('invalid document slice boundary')
  return [
    { ...clip, to: cut },
    { ...clip, from: cut },
  ]
}

/** Cell-aware cut points protect every column's glyphs and widow/orphan constraints. */
export function measuredTableCuts(table: HTMLTableElement, origin: number): number[] {
  const rectsOf = createLineRectsCache()
  const rows = [...table.rows]
  const spans = rows.flatMap((row) => [...row.cells]).filter((cell) => cell.rowSpan > 1)
  const cuts: number[] = []
  const allLines = rectsOf(table, 1)
  const tableTop = table.getBoundingClientRect().top
  for (const row of rows) {
    const box = row.getBoundingClientRect()
    const cells = [
      ...new Set([
        ...row.cells,
        ...spans.filter((cell) => {
          const rect = cell.getBoundingClientRect()
          return rect.top < box.bottom && rect.bottom > box.top
        }),
      ]),
    ]
    const bands = cells.map((cell) => {
      const top = cell.getBoundingClientRect().top - box.top
      return rectsOf(cell, 1).map(
        (line) => [top + line.offset, top + line.bottom] as [number, number],
      )
    })
    const paras = cells.flatMap((cell) =>
      [...cell.querySelectorAll<HTMLElement>('p')].map((para) => {
        const top = para.getBoundingClientRect().top - box.top
        return rectsOf(para, 1).map(
          (line) => [top + line.offset, top + line.bottom] as [number, number],
        )
      }),
    )
    cuts.push(...cellCutYs(bands, box.height, paras).map((cut) => cut + box.top - origin))
    const y = box.bottom - tableTop
    if (!allLines.some((line) => line.offset < y - 0.5 && line.bottom > y + 0.5))
      cuts.push(box.bottom - origin)
  }
  return [...new Set(cuts.map((cut) => Math.round(cut * 100) / 100))].sort((a, b) => a - b)
}
