/** Language and missing-glyph decisions ported from createSystemFontMetrics. */
import type { RunStyle } from '@genoffice/pptx-render'

interface OpentypeFontLike {
  charToGlyphIndex?: (char: string) => number
}
interface FontEntry {
  font: OpentypeFontLike
  substituted?: boolean
}
const ETHIOPIC_RE = /[\u1200-\u139f\u2d80-\u2ddf\uab00-\uab2f]/
const SYMBOL_BULLET_GLYPH_RE = /^[•■□▪▫▲►▼◄◊○●◘◙]+$/

export function createScriptFallback(resolveEntry: (style: RunStyle) => FontEntry | undefined) {
  const scriptFallbackFor = (
    text: string,
    e: { font: OpentypeFontLike } | undefined,
    style: RunStyle,
  ): string | undefined => {
    const lacks = (probe: string) => !e || e.font.charToGlyphIndex?.(probe) === 0
    if (style.substScript === 'ko' && /[가-힣]/.test(text) && lacks('가')) return 'Malgun Gothic'
    if (style.substScript === 'ja' && /[぀-ヿ]/.test(text) && lacks('あ')) return 'Yu Gothic'
    // Ethiopic has no language gate: PowerPoint draws it in Nyala whatever the run's lang
    // (pdffonts probe on an en-US Calibri run; Chromium's per-glyph fallback lands on Kefa,
    // whose glyphs run ~1.3x larger). The fallback face must carry the glyph itself, or
    // measure would re-enter forever on a subset Nyala
    if (ETHIOPIC_RE.test(text) && lacks('\u12a0')) {
      const nyala = resolveEntry({ ...style, fontFamily: 'Nyala' })
      if (nyala && !nyala.substituted && nyala.font.charToGlyphIndex?.('\u12a0')) return 'Nyala'
    }
    // Geometric bullets the face lacks draw in Arial, PowerPoint's linked symbol font (its ● is
    // 0.43em whatever the run font; Chromium's per-glyph fallback on macOS lands on a CJK face
    // with a 0.75em circle, which buSzPts then scales up — seen in an Open Sans deck)
    if (SYMBOL_BULLET_GLYPH_RE.test(text) && lacks(text[0]!)) {
      const arial = resolveEntry({ ...style, fontFamily: 'Arial' })
      if (arial && !arial.substituted && arial.font.charToGlyphIndex?.(text[0]!)) return 'Arial'
    }
    return undefined
  }
  return scriptFallbackFor
}
