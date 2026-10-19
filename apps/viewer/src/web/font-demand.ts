import type { RunStyle } from '@genoffice/pptx-render'

export interface AvailableFont {
  id: string
  family: string
  bold: boolean
  italic: boolean
  names: string[]
}

const normalize = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_]/g, '')
const key = (name: string, bold: boolean, italic: boolean) =>
  `${normalize(name)}|${+bold}${+italic}`

/** Discover dependencies through the original layout calls, including its fallback faces. */
export function createFontDemand(fonts: AvailableFont[], unavailable = new Set<string>()) {
  const byName = new Map<string, AvailableFont[]>()
  for (const font of fonts)
    for (const name of new Set([font.family, ...font.names])) {
      const fontKey = key(name, font.bold, font.italic)
      byName.set(fontKey, [font, ...(byName.get(fontKey) || [])])
    }
  const wanted = new Set<string>()
  const add = (name: string, bold: boolean, italic: boolean) => {
    const available = (fontKey: string) =>
      byName.get(fontKey)?.find((font) => !unavailable.has(font.id))
    const face = available(key(name, bold, italic)) || available(key(name, false, false))
    if (face) wanted.add(face.id)
  }
  return {
    request(style: RunStyle, text = '') {
      add(style.fontFamily, !!style.bold, !!style.italic)
      // A failed or uncovered face still needs the original Latin fallback metrics.
      add('Carlito', !!style.bold, !!style.italic)
      if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text))
        add('Noto Sans CJK SC', !!style.bold, !!style.italic)
      if (/[\u0600-\u06ff\u0750-\u077f]/.test(text)) add('Noto Naskh Arabic', false, false)
    },
    ids: () => wanted,
  }
}
