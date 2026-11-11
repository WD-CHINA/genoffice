import type { DocxPageBlock } from './docx-page-index'
import type { PageDescriptor } from './docx-pagination'
import type { SectionPage } from './docx-section-layout'

function blockTop(page: PageDescriptor, index: number, blocks: readonly DocxPageBlock[], padding: number): number {
  const sectionPage = page as Partial<SectionPage>
  const region = sectionPage.regions?.find((region) => region.columns.some((column) => column.blockStart <= index && index < column.blockEnd))
  const column = region?.columns.find((column) => column.blockStart <= index && index < column.blockEnd)
  let top = (sectionPage.paddingTop ?? padding) + (region?.top ?? 0)
  for (let block = column?.blockStart ?? page.blockStart; block < index; block++) top += blocks[block].height
  return top
}

export interface DocxScrollAnchor {
  unitId: string
  blockIndex: number
  offset: number
  row?: number
  paragraph?: number
}

/** Capture a stable source reference, never a page number that reflow can change. */
export function captureDocxAnchor(
  blocks: readonly DocxPageBlock[], pages: readonly PageDescriptor[],
  tops: readonly number[], scrollTop: number, paddingTop: number,
): DocxScrollAnchor | undefined {
  if (!pages.length) return undefined
  let pageIndex = 0
  while (pageIndex + 1 < tops.length && tops[pageIndex + 1] <= scrollTop) pageIndex++
  const page = pages[pageIndex]
  for (let index = page.blockStart; index < page.blockEnd; index++) {
    const top = tops[pageIndex] + blockTop(page, index, blocks, paddingTop)
    const block = blocks[index]
    if (top + block.height > scrollTop || index === page.blockEnd - 1) {
      // Repeated headers are not unique anchors: use a body row when available.
      const row = block.tablePage?.rows.find((entry) => entry.row >= (block.headerRows ?? 0))
        ?? block.tablePage?.rows.at(-1)
      return {
        unitId: block.unitId, blockIndex: block.blockIndex, offset: scrollTop - top,
        ...(row ? { row: row.row, paragraph: row.part?.start ?? 0 } : {}),
      }
    }
  }
  return undefined
}

/** Return undefined when a replacement document no longer contains this source reference. */
export function restoreDocxAnchor(
  anchor: DocxScrollAnchor, blocks: readonly DocxPageBlock[],
  pages: readonly PageDescriptor[], tops: readonly number[], paddingTop: number,
): number | undefined {
  const index = blocks.findIndex((block) => block.unitId === anchor.unitId &&
    block.blockIndex === anchor.blockIndex && (anchor.row === undefined ||
      block.tablePage?.rows.some((row) => row.row === anchor.row && (!row.part ||
        ((anchor.paragraph ?? 0) >= row.part.start && (anchor.paragraph ?? 0) < row.part.end)))))
  if (index < 0) return undefined
  const pageIndex = pages.findIndex((page) => page.blockStart <= index && page.blockEnd > index)
  if (pageIndex < 0) return undefined
  const top = tops[pageIndex] + blockTop(pages[pageIndex], index, blocks, paddingTop)
  return Math.max(0, top + anchor.offset)
}
