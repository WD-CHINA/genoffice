import type { PageGeometry } from '@genoffice/viewer-renderers/pdf/renderer/page-probe'

// Keep network fetches demand-driven; without disableStream PDF.js would still
// stream the entire file even with disableAutoFetch enabled.
export const PDF_LOAD_OPTIONS = {
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 256 * 1024,
  // PDF.js can resize large decoded images rather than dropping them.
  canvasMaxAreaInBytes: 32 * 1024 * 1024,
}

export const PDF_RESIDENT_PAGES = 32
export const PDF_RESIDENT_PIXELS = 24_000_000
export const PDF_PAGE_PIXELS = 8_000_000

/** Visible pages nearest the reader, with a fixed bound even at deep zoom-out. */
export function residentPdfPages(
  visible: ReadonlySet<number>,
  current: number,
  pagePixels: (index: number) => number = () => PDF_PAGE_PIXELS,
): Set<number> {
  const result = new Set<number>()
  let pixels = 0
  for (const page of [...new Set([current, ...visible])].sort(
    (a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b,
  )) {
    const cost = Math.max(1, Math.min(PDF_PAGE_PIXELS, pagePixels(page)))
    if (pixels + cost > PDF_RESIDENT_PIXELS || result.size >= PDF_RESIDENT_PAGES) break
    result.add(page)
    pixels += cost
  }
  return result
}

export function viewerPageGeometry(page: PageGeometry) {
  return {
    pw: page.width,
    ph: page.height,
    rot: page.rotate,
    x0: page.origin[0],
    y0: page.origin[1],
    userUnit: page.userUnit,
  }
}
