import * as opentype from 'opentype.js'
import type { ParsedFace } from './bundled-metrics'
import type { MetricFont } from './metric-font-types'

// Node loads the package's UMD default; Vite workers use its ESM named exports.
const parseFont: typeof opentype.parse = opentype.parse || Reflect.get(opentype, 'default').parse

export interface FontAdvanceData {
  unitsPerEm: number
  ascender: number
  descender: number
  lineGap: number
  advances: Array<[number, number, number]>
}

/** Unshaped WOFF2 metrics. Browser feedback replaces advances with shaped widths. */
export function fontFromAdvances(data: FontAdvanceData): ParsedFace['font'] {
  const glyphs = new Map(data.advances.map(([cp, id, width]) => [cp, { id, width }]))
  return {
    unitsPerEm: data.unitsPerEm,
    ascender: data.ascender,
    descender: data.descender,
    lineGap: data.lineGap,
    charToGlyphIndex: (char) => glyphs.get(char.codePointAt(0)!)?.id ?? 0,
    getAdvanceWidth: (text, size) =>
      ([...text].reduce((sum, char) => sum + (glyphs.get(char.codePointAt(0)!)?.width ?? 0), 0) /
        data.unitsPerEm) *
      size,
  }
}

/** One parsed font per source URL, even when many range aliases share its bytes. */
export function createMetricFontLoader(fetcher: typeof fetch = fetch) {
  const sources = new Map<string, Promise<ParsedFace['font']>>()
  return async (face: MetricFont): Promise<ParsedFace | null> => {
    const key = `${face.url}|${!!face.tuneWin}`
    if (!sources.has(key))
      sources.set(
        key,
        (async () => {
          const response = await fetcher(face.metricsUrl ?? face.url)
          if (!response.ok) throw new Error('Font download failed')
          if (face.metricsUrl) return fontFromAdvances(await response.json())
          const parsed = parseFont(await response.arrayBuffer()) as ReturnType<typeof parseFont> & {
            lineGap?: number
          }
          const hhea = parsed.tables.hhea
          parsed.lineGap = hhea?.lineGap ?? 0
          const os2 = parsed.tables.os2
          if (face.tuneWin && os2?.usWinAscent && os2.usWinDescent != null) {
            parsed.ascender = os2.usWinAscent
            parsed.descender = -Math.abs(os2.usWinDescent)
            parsed.lineGap = 0
          }
          return parsed
        })(),
      )
    try {
      return { ...face, font: await sources.get(key)! }
    } catch {
      return null
    }
  }
}
