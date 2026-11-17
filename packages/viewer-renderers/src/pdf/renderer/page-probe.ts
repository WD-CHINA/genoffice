export interface PageGeometry {
  width: number
  height: number
  rotate: number
  origin: [number, number]
  userUnit: number
}

export interface PageProbeFailure {
  /** 1-based page number */
  page: number
  message: string
}

export interface PageProbeResult {
  pages: PageGeometry[]
  failures: PageProbeFailure[]
}

export const FALLBACK_PAGE_GEOMETRY: PageGeometry = {
  width: 595,
  height: 842,
  rotate: 0,
  origin: [0, 0],
  userUnit: 1,
}

type GeometryDocument = Parameters<typeof probePageGeometry>[0]

/** Read only the requested page, retaining original page numbers in failures. */
export async function probeOnePage(
  doc: GeometryDocument,
  pageNo: number,
  fallback: PageGeometry = FALLBACK_PAGE_GEOMETRY,
  cancelled: () => boolean = () => false,
): Promise<{ geometry: PageGeometry; failure?: PageProbeFailure } | null> {
  const result = await probePageGeometry(
    { numPages: 1, getPage: () => doc.getPage(pageNo) },
    cancelled,
  )
  if (!result.pages.length) return null
  return result.failures.length
    ? { geometry: fallback, failure: { ...result.failures[0]!, page: pageNo } }
    : { geometry: result.pages[0]! }
}

/**
 * Probes every page's geometry (size, rotation, origin, userUnit) in document
 * order. A page whose probe throws degrades to the previous good geometry (A4
 * before the first success) and is reported in `failures` instead of failing
 * the whole document — one broken page deep in a 450-page textbook must not
 * blank the other 449 (genoffice#2366: the open path used to destroy the
 * document over a single getPage rejection, leaving a white viewer and the
 * error only in the console).
 */
export async function probePageGeometry(
  doc: {
    numPages: number
    getPage: (n: number) => Promise<{
      getViewport: (o: { scale: number; rotation: number }) => { width: number; height: number }
      rotate?: number | null
      view: number[]
      userUnit?: number | null
    }>
  },
  cancelled: () => boolean = () => false,
): Promise<PageProbeResult> {
  const pages: PageGeometry[] = []
  const failures: PageProbeFailure[] = []
  let lastGood = FALLBACK_PAGE_GEOMETRY
  for (let i = 1; i <= doc.numPages; i++) {
    if (cancelled()) break
    try {
      const page = await doc.getPage(i)
      if (cancelled()) break
      // Unrotated size; display size is derived by geom from the total rotation
      const vp = page.getViewport({ scale: 1, rotation: 0 })
      if (![vp.width, vp.height].every((value) => Number.isFinite(value) && value > 0))
        throw new Error('Invalid PDF page dimensions')
      const geo: PageGeometry = {
        width: vp.width,
        height: vp.height,
        rotate: page.rotate ?? 0,
        origin: [page.view[0] ?? 0, page.view[1] ?? 0],
        userUnit: page.userUnit ?? 1,
      }
      pages.push(geo)
      lastGood = geo
    } catch (err) {
      if (cancelled()) break
      failures.push({ page: i, message: err instanceof Error ? err.message : String(err) })
      pages.push(lastGood)
    }
  }
  return { pages, failures }
}
