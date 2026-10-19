import {
  HeuristicMetrics,
  OpentypeMetrics,
  type FontMetricsProvider,
  type RunStyle,
} from '@genoffice/pptx-render'

export interface ParsedFace {
  family: string
  bold: boolean
  italic: boolean
  names: string[]
  font: {
    unitsPerEm: number
    ascender: number
    descender: number
    lineGap?: number
    getAdvanceWidth(text: string, fontSize: number, options?: { kerning?: boolean }): number
    charToGlyphIndex?(char: string): number
    charToGlyph?(char: string): { index: number }
  }
}

export interface WidthItem {
  key: string
  family: string
  text: string
  bold: boolean
  italic: boolean
}

function norm(name: string) {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_]/g, '')
}

function hasCjk(text: string) {
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)
}

function hasArabic(text: string) {
  return /[\u0600-\u06ff\u0750-\u077f]/.test(text)
}

/** opentype metrics over the shipped metric-compatible faces, plus a canvas refine queue. */
export function createBundledMetrics(
  faces: ParsedFace[],
  onRequest?: (style: RunStyle, text?: string) => void,
  onMeasure?: (key: string) => void,
) {
  const byName = new Map<string, ParsedFace>()
  for (const face of faces) {
    byName.set(`${norm(face.family)}|${face.bold ? 1 : 0}${face.italic ? 1 : 0}`, face)
    for (const name of face.names)
      byName.set(`${norm(name)}|${face.bold ? 1 : 0}${face.italic ? 1 : 0}`, face)
  }
  const pending = new Map<string, WidthItem>()
  const cache = new Map<string, number>()
  const fallbacks = new Set<string>()
  const resolve = (
    style: RunStyle,
    text?: string,
  ): { face: ParsedFace; substituted: boolean } | undefined => {
    onRequest?.(style, text)
    const key = `${norm(style.fontFamily)}|${style.bold ? 1 : 0}${style.italic ? 1 : 0}`
    const exact = byName.get(key) || byName.get(`${norm(style.fontFamily)}|00`)
    if (exact && (!text || !hasCjk(text) || covers(exact, text)))
      return { face: exact, substituted: false }
    if (text && hasCjk(text)) {
      const cjk =
        byName.get(`notosanscjksc|${style.bold ? 1 : 0}${style.italic ? 1 : 0}`) ||
        byName.get('notosanscjksc|00')
      if (cjk) return { face: cjk, substituted: !exact }
    }
    if (text && hasArabic(text)) {
      const arabic = byName.get('notonaskharabic|00')
      if (arabic) return { face: arabic, substituted: !exact }
    }
    const latin =
      byName.get(`carlito|${style.bold ? 1 : 0}${style.italic ? 1 : 0}`) || byName.get('carlito|00')
    return latin ? { face: latin, substituted: !exact } : undefined
  }
  const inner = new OpentypeMetrics((style) => resolve(style)?.face.font, new HeuristicMetrics())
  const provider: FontMetricsProvider = {
    metrics: (style) => inner.metrics(style),
    measure: (text, style) => {
      const found = resolve(style, text)
      const family = found?.face.family || style.fontFamily
      if (found?.substituted) fallbacks.add(style.fontFamily)
      if (text) {
        const key = `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}|${family}|${text}`
        onMeasure?.(key)
        const known = cache.get(key)
        if (known != null) return (known / 100) * style.fontSizePx
        pending.set(key, { key, family, text, bold: style.bold, italic: style.italic })
      }
      if (!found) return inner.measure(text, style)
      return inner.measure(text, { ...style, fontFamily: found.face.family })
    },
    displayFamily: (style, text) => resolve(style, text)?.face.family || style.fontFamily,
    substituted: (style) => resolve(style)?.substituted === true,
  }
  return {
    provider,
    fallbacks: () => [...fallbacks],
    pendingWidthMeasurements: () => [...pending.values()],
    acceptWidthMeasurements(widths: Record<string, number>) {
      for (const [key, width] of Object.entries(widths)) {
        if (!pending.has(key) || !Number.isFinite(width) || width < 0)
          throw new Error('Invalid measurement')
        cache.set(key, width)
        pending.delete(key)
      }
    },
  }
}

function covers(face: ParsedFace, text: string) {
  const glyph =
    face.font.charToGlyphIndex || ((char: string) => face.font.charToGlyph?.(char)?.index ?? 1)
  for (const char of text) {
    if (char.trim() && glyph.call(face.font, char) === 0) return false
  }
  return true
}
