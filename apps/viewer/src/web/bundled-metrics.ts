import {
  HeuristicMetrics,
  OpentypeMetrics,
  type FontMetricsProvider,
  type RunStyle,
} from '@genoffice/pptx-render'
import { fontName, fontVariants, fallbackFamilies } from './font-selection'
import type { MetricFont } from './metric-font-types'
import { createScriptFallback } from '@genoffice/viewer-services/slides/shared/script-fallback'

export interface ParsedFace {
  family: string
  bold: boolean
  italic: boolean
  names: string[]
  descriptors?: MetricFont['descriptors']
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
  kerning?: boolean
}

/** opentype metrics over the shipped metric-compatible faces, plus a canvas refine queue. */
export function createBundledMetrics(
  faces: ParsedFace[],
  onRequest?: (style: RunStyle, text?: string) => void,
  onMeasure?: (key: string) => void,
) {
  const byName = new Map<string, ParsedFace[]>()
  for (const face of faces)
    for (const name of new Set([face.family, ...face.names])) {
      const key = fontName(name)
      byName.set(key, [...(byName.get(key) ?? []), face])
    }
  const groups = new Map<string, ParsedFace[]>()
  const group = (name: string, style: RunStyle) => {
    const key = `${fontName(name)}|${+!!style.bold}${+!!style.italic}`
    if (!groups.has(key)) groups.set(key, fontVariants(byName.get(fontName(name)) ?? [], style))
    return groups.get(key)!
  }
  const pending = new Map<string, WidthItem>()
  const cache = new Map<string, number>()
  const fallbacks = new Set<string>()
  const ranges = new WeakMap<ParsedFace, Array<[number, number]>>()
  const contains = (face: ParsedFace, char: string) => {
    const range = face.descriptors?.unicodeRange
    if (range) {
      if (!ranges.has(face))
        ranges.set(
          face,
          range.split(',').map((part) => {
            const raw = part.trim().replace(/^U\+/i, '')
            if (raw.includes('?'))
              return [parseInt(raw.replace(/\?/g, '0'), 16), parseInt(raw.replace(/\?/g, 'F'), 16)]
            const [lo, hi = lo] = raw.split('-')
            return [parseInt(lo!, 16), parseInt(hi!, 16)]
          }),
        )
      const cp = char.codePointAt(0)!
      if (!ranges.get(face)!.some(([lo, hi]) => cp >= lo && cp <= hi)) return false
    }
    const glyph =
      face.font.charToGlyphIndex ?? ((c: string) => face.font.charToGlyph?.(c)?.index ?? 1)
    return glyph.call(face.font, char) !== 0
  }
  const pick = (members: ParsedFace[], char: string) => {
    for (let i = members.length - 1; i >= 0; i--) if (contains(members[i]!, char)) return members[i]
    return undefined
  }
  const covers = (members: ParsedFace[], text: string) =>
    [...text].every(
      (char) => !char.trim() || /\u200c|\u200d|\ufe0e|\ufe0f/.test(char) || pick(members, char),
    )
  const scriptEntry = (style: RunStyle) => {
    const members = group(style.fontFamily, style)
    // Explicit catalog/embedded aliases are available metric-compatible faces.
    // Missing system faces never become a pretend match in the browser.
    return members.length
      ? {
          font: { charToGlyphIndex: (char: string) => (pick(members, char) ? 1 : 0) },
          substituted: false,
        }
      : undefined
  }
  const scriptFallback = createScriptFallback(scriptEntry)
  const resolve = (style: RunStyle, text = '') => {
    onRequest?.(style, text)
    const exact = group(style.fontFamily, style)
    const preferred = scriptFallback(text, scriptEntry(style), style)
    if (preferred) {
      const members = group(preferred, style)
      if (members.length && covers(members, text)) return { members, substituted: !exact.length }
    }
    if (exact.length && covers(exact, text)) return { members: exact, substituted: false }
    for (const family of fallbackFamilies(style, text)) {
      const members = group(family, style)
      if (members.length && covers(members, text)) return { members, substituted: !exact.length }
    }
    // Keep an available font's line metrics even for an uncovered glyph; browser
    // refinement and fallback reporting remain active rather than inventing coverage.
    const members = exact.length ? exact : group('Carlito', style)
    return members.length ? { members, substituted: !exact.length } : undefined
  }
  const heuristic = new HeuristicMetrics()
  const inner = (face: ParsedFace) => new OpentypeMetrics(() => face.font, heuristic)
  const scaleOf = (face: ParsedFace) => parseFloat(face.descriptors?.sizeAdjust ?? '100') / 100
  const measure = (text: string, style: RunStyle, members: ParsedFace[]) => {
    let total = 0,
      fragment = '',
      previous: ParsedFace | undefined
    const flush = () => {
      if (!fragment) return
      total += previous
        ? inner(previous).measure(fragment, {
            ...style,
            fontSizePx: style.fontSizePx * scaleOf(previous),
          })
        : heuristic.measure(fragment, style)
      fragment = ''
    }
    for (const char of text) {
      const face = pick(members, char)
      if (face !== previous) flush()
      previous = face
      fragment += char
    }
    flush()
    return total
  }
  const provider: FontMetricsProvider = {
    metrics: (style) => {
      const found = resolve(style)
      if (!found) return heuristic.metrics(style)
      const face = pick(found.members, 'A') ?? found.members[found.members.length - 1]!
      const scale = scaleOf(face)
      const metrics = inner(face).metrics({ ...style, fontSizePx: style.fontSizePx * scale })
      const override = (value: string | undefined, fallback: number) =>
        value && value !== 'normal'
          ? (parseFloat(value) / 100) * style.fontSizePx * scale
          : fallback
      const ascent = override(face.descriptors?.ascentOverride, metrics.ascent)
      const descent = override(face.descriptors?.descentOverride, metrics.descent)
      const externalLeading = override(
        face.descriptors?.lineGapOverride,
        metrics.externalLeading ?? 0,
      )
      return { ascent, descent, lineHeight: ascent + descent, externalLeading }
    },
    measure: (text, style) => {
      const found = resolve(style, text)
      const family = found?.members[0]?.family || style.fontFamily
      if (found?.substituted) fallbacks.add(style.fontFamily)
      if (text) {
        const key = `${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}${style.kerning === false ? 'n' : ''}|${family}|${text}`
        onMeasure?.(key)
        const known = cache.get(key)
        if (known != null) return (known / 100) * style.fontSizePx
        pending.set(key, {
          key,
          family,
          text,
          bold: style.bold,
          italic: style.italic,
          kerning: style.kerning,
        })
      }
      return found ? measure(text, style, found.members) : heuristic.measure(text, style)
    },
    displayFamily: (style, text) => resolve(style, text)?.members[0]?.family || style.fontFamily,
    substituted: (style) => resolve(style)?.substituted === true,
  }
  return {
    provider,
    fallbacks: () => [...fallbacks],
    pendingWidthMeasurements: () => [...pending.values()],
    retainWidthMeasurements(keys: ReadonlySet<string>) {
      for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key)
      for (const key of pending.keys()) if (!keys.has(key)) pending.delete(key)
    },
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
