import { streamDocxBlocks } from './docx-stream'

export interface DocxSectionSlice {
  start: number
  end: number
  xml: string
}

export interface DocxMetadata {
  /** Top-level body blocks seen while streaming. */
  blockCount: number
  /** Number of w:sectPr elements (section breaks). */
  sectionCount: number
  /** Number of w:commentRangeStart anchors. */
  commentRangeCount: number
  /** True when any explicit page break / pageBreakBefore / lastRenderedPageBreak appears. */
  hasPageBreak: boolean
  /** Raw section slices with document.xml offsets, for sectionAt(). */
  sections: DocxSectionSlice[]
  /** Comment range ids seen in document.xml. */
  commentRangeStarts: Set<string>
  /** Absolute offset of the first explicit page break, when present. */
  firstPageBreakAt?: number
}

/**
 * Gate A.3/A.9 metadata pass: collect document-level facts while scanning
 * document.xml as a stream. The parser context can use this instead of
 * materializing the whole XML string.
 */
export async function scanDocxMetadata(
  input: AsyncIterable<string | Uint8Array>,
): Promise<DocxMetadata> {
  let blockCount = 0
  let sectionCount = 0
  let commentRangeCount = 0
  let hasPageBreak = false
  let firstPageBreakAt: number | undefined
  const sections: DocxSectionSlice[] = []
  const commentRangeStarts = new Set<string>()
  for await (const block of streamDocxBlocks(input)) {
    blockCount++
    for (const match of block.xml.matchAll(/<w:sectPr[^>]*\/>|<w:sectPr[\s\S]*?<\/w:sectPr>/g)) {
      sectionCount++
      sections.push({
        start: block.start + (match.index ?? 0),
        end: block.start + (match.index ?? 0) + match[0].length,
        xml: match[0],
      })
    }
    for (const match of block.xml.matchAll(
      /<w:commentRangeStart\b[^>]*\bw:id\s*=\s*["']([^"']+)["']/g,
    )) {
      commentRangeCount++
      commentRangeStarts.add(match[1])
    }
    if (!hasPageBreak) {
      const match = /<w:br [^>]*w:type="page"|<w:pageBreakBefore\b|<w:lastRenderedPageBreak\b/.exec(
        block.xml,
      )
      if (match) {
        hasPageBreak = true
        firstPageBreakAt = block.start + (match.index ?? 0)
      }
    }
  }
  return {
    blockCount,
    sectionCount,
    commentRangeCount,
    hasPageBreak,
    sections,
    commentRangeStarts,
    ...(firstPageBreakAt !== undefined ? { firstPageBreakAt } : {}),
  }
}
