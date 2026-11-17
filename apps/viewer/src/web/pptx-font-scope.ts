import type { PptxDeck } from './pptx-session'

/** Own the document's FontFaces; load only measured families, including range aliases. */
export function createPptxFontScope() {
  const loaded = new Map<string, FontFace[]>()
  let closed = false
  return {
    async load(
      deck: Pick<PptxDeck, 'fonts' | 'measurements'>,
      bytes: (id: string) => Promise<ArrayBuffer | null>,
    ) {
      const families = new Set(deck.measurements.map((item) => item.family))
      const wanted = deck.fonts.filter(
        (font) => families.has(font.family) || font.also?.some((name) => families.has(name)),
      )
      // Cascade order matters for overlapping unicode ranges. Decode concurrently,
      // then register in catalog order so network timing cannot choose the glyph.
      const prepared = await Promise.all(
        wanted.map(async (font) => {
          if (closed || loaded.has(font.id)) return null
          for (let attempt = 0; attempt < 3 && !closed; attempt++) {
            try {
              const source = font.url ? `url(${font.url})` : await bytes(font.id)
              if (!source) return null
              const faces = await Promise.all(
                [...new Set([font.family, ...(font.also ?? [])])].map(async (family) => {
                  const face = new FontFace(family, source, {
                    ...font.descriptors,
                    weight: font.bold ? '700' : '400',
                    style: font.italic ? 'italic' : 'normal',
                  })
                  await face.load()
                  return face
                }),
              )
              return { id: font.id, faces }
            } catch {
              if (attempt < 2)
                await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
            }
          }
          return null
        }),
      )
      if (closed) return
      for (const item of prepared) {
        if (!item || loaded.has(item.id)) continue
        for (const face of item.faces) document.fonts.add(face)
        loaded.set(item.id, item.faces)
      }
      await document.fonts.ready
    },
    close() {
      closed = true
      for (const faces of loaded.values()) for (const face of faces) document.fonts.delete(face)
      loaded.clear()
    },
  }
}
