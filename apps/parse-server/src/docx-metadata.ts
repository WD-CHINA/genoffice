import { streamDocxBlocks } from './docx-stream'

export interface DocxMetadata {
  /** Top-level body blocks seen while streaming. */
  blockCount: number
  /** Number of w:sectPr elements (section breaks). */
  sectionCount: number
  /** Number of w:commentRangeStart anchors. */
  commentRangeCount: number
  /** True when any explicit page break / pageBreakBefore / lastRenderedPageBreak appears. */
  hasPageBreak: boolean
}

/**
 * Gate A.3 metadata pass: collect document-level facts while scanning
 * document.xml as a stream. The parser context can use this later instead of
 * materializing the whole XML string.
 */
export async function scanDocxMetadata(
  input: AsyncIterable<string | Uint8Array>,
): Promise<DocxMetadata> {
  let blockCount = 0
  let sectionCount = 0
  let commentRangeCount = 0
  let hasPageBreak = false
  for await (const block of streamDocxBlocks(input)) {
    blockCount++
    sectionCount += (block.xml.match(/<w:sectPr\b/g) || []).length
    commentRangeCount += (block.xml.match(/<w:commentRangeStart\b/g) || []).length
    if (
      !hasPageBreak &&
      /<w:br [^>]*w:type="page"|<w:pageBreakBefore\b|<w:lastRenderedPageBreak\b/.test(block.xml)
    ) {
      hasPageBreak = true
    }
  }
  return { blockCount, sectionCount, commentRangeCount, hasPageBreak }
}
