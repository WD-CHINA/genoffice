export interface BlockMeasure {
  /** Measured block height in CSS pixels. */
  height: number
  /** Keep this block on the same page as the next one when possible. */
  keepWithNext?: boolean
  /** Force a page break before this block. */
  breakBefore?: boolean
}

export interface PageDescriptor {
  index: number
  blockStart: number
  blockEnd: number
  /** Content height of the page (excluding forced gaps). */
  height: number
}

/**
 * Pure incremental pagination for read-only DOCX blocks.
 *
 * This is the frontend half of the spike: blocks arrive as measured chunks,
 * pages are descriptors over block ranges, and the view can mount only the
 * visible pages. It intentionally does not know about Tiptap or DOM.
 */
export function paginateBlocks(
  blocks: readonly BlockMeasure[],
  pageHeight: number,
): PageDescriptor[] {
  if (pageHeight <= 0) throw new Error('pageHeight must be positive')
  const pages: PageDescriptor[] = []
  let start = 0
  let height = 0
  const flush = (end: number) => {
    if (end <= start) return
    pages.push({ index: pages.length, blockStart: start, blockEnd: end, height })
    start = end
    height = 0
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    const next = blocks[index + 1]
    if (block.breakBefore) flush(index)
    const keepNext =
      block.keepWithNext === true &&
      !!next &&
      height > 0 &&
      height + block.height + next.height > pageHeight
    if (keepNext) flush(index)
    if (block.height > pageHeight) {
      // An oversized block owns its page; splitting is a later renderer concern.
      flush(index)
      pages.push({
        index: pages.length,
        blockStart: index,
        blockEnd: index + 1,
        height: block.height,
      })
      start = index + 1
      height = 0
      continue
    }
    if (height > 0 && height + block.height > pageHeight) flush(index)
    height += block.height
  }
  flush(blocks.length)
  return pages
}

export interface VisiblePages {
  start: number
  end: number
}

/** Visible page range with overscan, given cumulative page tops. */
export function visiblePages(
  pageTops: readonly number[],
  pageHeights: readonly number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 2,
): VisiblePages {
  if (!pageTops.length) return { start: 0, end: 0 }
  let low = 0
  let high = pageTops.length - 1
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (pageTops[mid] + pageHeights[mid] < scrollTop) low = mid + 1
    else high = mid
  }
  let end = low
  const bottom = scrollTop + viewportHeight
  while (end < pageTops.length && pageTops[end] < bottom) end++
  return {
    start: Math.max(0, low - overscan),
    end: Math.min(pageTops.length, end + overscan),
  }
}

/** Cumulative top offsets for page descriptors. */
export function pageTops(pages: readonly PageDescriptor[]): number[] {
  const tops: number[] = []
  let top = 0
  for (const page of pages) {
    tops.push(top)
    top += page.height
  }
  return tops
}
