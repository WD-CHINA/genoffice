import { electronFontResolution } from './electron-font-catalog'
import type { RunStyle } from '@genoffice/pptx-render'
import { fontName, fontVariants, fallbackFamilies } from './font-selection'
import { createScriptFallback } from '@genoffice/viewer-services/slides/shared/script-fallback'

export interface AvailableFont {
  id: string
  family: string
  bold: boolean
  italic: boolean
  names: string[]
}

/** Discover dependencies through the original layout calls, including its fallback faces. */
export function createFontDemand(fonts: AvailableFont[], unavailable = new Set<string>()) {
  const byName = new Map<string, AvailableFont[]>()
  for (const font of fonts)
    for (const name of new Set([font.family, ...font.names])) {
      const fontKey = fontName(name)
      byName.set(fontKey, [...(byName.get(fontKey) || []), font])
    }
  const wanted = new Set<string>()
  // Discovery knows availability, not glyphs. Request the main package's possible
  // script fallback as well; actual selection checks loaded glyph coverage.
  const scriptFallback = createScriptFallback((style) =>
    byName.get(fontName(style.fontFamily))?.some((face) => !unavailable.has(face.id))
      ? { font: { charToGlyphIndex: () => 1 }, substituted: false }
      : undefined,
  )
  const add = (name: string, style: RunStyle) => {
    const candidates = (byName.get(fontName(name)) ?? []).filter(
      (face) => !unavailable.has(face.id),
    )
    for (const face of fontVariants(candidates, style)) wanted.add(face.id)
  }
  return {
    request(style: RunStyle, text = '') {
      add(electronFontResolution(style, text)?.family ?? style.fontFamily, style)
      add('Carlito', style)
      const preferred = scriptFallback(text, undefined, style)
      if (preferred) add(preferred, style)
      for (const family of fallbackFamilies(style, text)) add(family, style)
    },
    ids: () => wanted,
  }
}
