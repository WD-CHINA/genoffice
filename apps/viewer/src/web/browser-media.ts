import { parseTheme, parseClrMap, resolveSchemeColor, type OpenedPptx } from '@genoffice/pptx-engine'
import { neutralizeJpegOrientation } from '@genoffice/viewer-services/slides/main/jpeg-orientation'
import { displayMime } from '@genoffice/viewer-services/slides/main/media-mime'
import UTIF from 'utif2'
// @ts-expect-error pako ships without types in this repo
import { deflate } from 'pako'

const SVG_THEME_SLOTS: Record<string, string> = {
  background1: 'bg1',
  text1: 'tx1',
  background2: 'bg2',
  text2: 'tx2',
  accent1: 'accent1',
  accent2: 'accent2',
  accent3: 'accent3',
  accent4: 'accent4',
  accent5: 'accent5',
  accent6: 'accent6',
  hyperlink: 'hlink',
  followedhyperlink: 'folHlink',
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function retint(svg: string, opened: OpenedPptx, slidePath?: string): string {
  const path = slidePath ?? opened.deck.slides[0]?.path
  if (!path) return svg
  try {
    const chain = opened.archive.resolveSlideChain(path)
    const themeXml = chain.themePath ? opened.archive.readText(chain.themePath) : null
    if (!themeXml) return svg
    const theme = parseTheme(themeXml)
    theme.clrMap = parseClrMap(
      chain.masterPath ? opened.archive.readText(chain.masterPath) ?? undefined : undefined,
      chain.layoutPath ? opened.archive.readText(chain.layoutPath) ?? undefined : undefined,
      opened.archive.readText(path) ?? undefined,
    )
    return svg.replace(/\.MsftOfcThm_(\w+?)_(Fill|Stroke)\w*\s*\{[^}]*\}/g, (rule, slot: string, kind: string) => {
      const scheme = SVG_THEME_SLOTS[slot.toLowerCase()]
      const color = scheme ? resolveSchemeColor(scheme, theme) : undefined
      if (!color) return rule
      const prop = kind === 'Stroke' ? 'stroke' : 'fill'
      return rule.replace(new RegExp(`${prop}\\s*:\\s*[^;}]+`, 'g'), `${prop}:${color}`)
    })
  } catch {
    return svg
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return ~crc >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  out.set(type.split('').map((char) => char.charCodeAt(0)), 4)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function rgbaToPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8
  header[9] = 6
  const compressed = deflate(raw)
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array()),
  ]
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    png.set(part, offset)
    offset += part.length
  }
  return png
}

function tiffToPng(bytes: Uint8Array): Uint8Array | null {
  try {
    const ifds = UTIF.decode(bytes as unknown as ArrayBuffer)
    if (!ifds.length) return null
    let page = ifds[0]
    let pixels = 0
    for (const ifd of ifds) {
      const width = Array.isArray(ifd.t256) ? ifd.t256[0] : ifd.width
      const height = Array.isArray(ifd.t257) ? ifd.t257[0] : ifd.height
      if (typeof width !== 'number' || typeof height !== 'number' || width < 1 || height < 1 || width > 32767 || height > 32767) continue
      if (width * height > pixels && width * height <= 256 * 1024 * 1024) {
        page = ifd
        pixels = width * height
      }
    }
    UTIF.decodeImage(bytes as unknown as ArrayBuffer, page)
    if (!page.width || !page.height) return null
    return rgbaToPng(UTIF.toRGBA8(page), page.width, page.height)
  } catch {
    return null
  }
}

export function browserMediaResolver(opened: OpenedPptx, slidePath?: string) {
  const cache = new Map<string, string | undefined>()
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef)
    const bytes = opened.archive.readBytes(mediaRef)
    let url: string | undefined
    if (bytes) {
      const mime = displayMime(mediaRef, bytes)
      if (mime === 'image/tiff') {
        const png = tiffToPng(bytes)
        if (png) url = `data:image/png;base64,${base64(png)}`
      } else if (mime === 'image/svg+xml') {
        let text = new TextDecoder().decode(bytes)
        if (text.includes('MsftOfcThm_')) text = retint(text, opened, slidePath)
        url = `data:${mime};base64,${base64(new TextEncoder().encode(text))}`
      } else {
        const served = mime === 'image/jpeg' ? neutralizeJpegOrientation(bytes) : bytes
        url = `data:${mime};base64,${base64(served)}`
      }
    }
    cache.set(mediaRef, url)
    return url
  }
}
