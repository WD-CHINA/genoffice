import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'

/** Viewer adaptation: callbacks use original, one-based PDF page numbers. */
export interface PageReadOptions {
  skipPage?: (page: number) => boolean
  cancelled?: () => boolean
  /** When provided, report an unreadable page and continue; default remains strict. */
  onPageError?: (page: number, error: unknown) => void
}

export async function readPageValue<T>(
  doc: Pick<PDFDocumentProxy, 'getPage'>,
  pageNo: number,
  read: (page: PDFPageProxy) => Promise<T>,
  options: PageReadOptions,
): Promise<T | undefined> {
  if (options.cancelled?.() || options.skipPage?.(pageNo)) return undefined
  try {
    const page = await doc.getPage(pageNo)
    if (options.cancelled?.()) return undefined
    const value = await read(page)
    return options.cancelled?.() ? undefined : value
  } catch (error) {
    if (options.cancelled?.()) return undefined
    if (!options.onPageError) throw error
    options.onPageError(pageNo, error)
    return undefined
  }
}
