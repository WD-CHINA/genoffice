import { parse as parseFont } from 'opentype.js'
import { openPptx, materializeSlide, listEmbeddedFonts, elementSpid, getSlideTransition, getSlideAnimations, getSlideLinks, getRunLinks } from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { browserMediaResolver } from './browser-media'
import { createBundledMetrics, type ParsedFace } from './bundled-metrics'
import { METRIC_FONTS, type MetricFont } from './metric-fonts'

type Opened = Awaited<ReturnType<typeof openPptx>>

let opened: Opened | null = null
let metrics: ReturnType<typeof createBundledMetrics> | null = null
let width = 960
let fontList: Array<{ id: string; family: string; bold: boolean; italic: boolean; url?: string; also?: string[] }> = []
const embedded = new Map<string, Uint8Array>()

function tuneCarlito(font: { ascender: number; descender: number; lineGap?: number; tables?: { os2?: { usWinAscent?: number; usWinDescent?: number } } }) {
  const os2 = font.tables?.os2
  if (os2?.usWinAscent && os2.usWinDescent != null) {
    font.ascender = os2.usWinAscent
    font.descender = -Math.abs(os2.usWinDescent)
    font.lineGap = 0
  }
}

async function loadMetric(font: MetricFont): Promise<ParsedFace | null> {
  const response = await fetch(font.url)
  if (!response.ok) return null
  try {
    const parsed = parseFont(await response.arrayBuffer())
    if (font.tuneWin) tuneCarlito(parsed)
    return { family: font.family, bold: font.bold, italic: font.italic, names: font.names, font: parsed }
  } catch {
    return {
      family: font.family,
      bold: font.bold,
      italic: font.italic,
      names: font.names,
      font: {
        unitsPerEm: 1000,
        ascender: 800,
        descender: -200,
        getAdvanceWidth() {
          throw new Error('font bytes are not measurable')
        },
        charToGlyphIndex() {
          return 0
        },
      },
    }
  }
}

function render() {
  if (!opened || !metrics) throw new Error('Presentation is not open')
  const slides = opened.deck.slides.map((slide, i) =>
    buildRenderSlide(slide, opened!.deck.size, {
      fitWidthPx: width,
      metrics: metrics!.provider,
      media: browserMediaResolver(opened!, slide.path),
      slideNo: i + 1,
    }),
  )
  const playback = opened.deck.slides.map((slide, index) => {
    const ids = new Map(slide.elements.map((el) => [elementSpid(el), el]))
    return {
      transition: getSlideTransition(slide),
      animations: getSlideAnimations(slide).flatMap((item) => {
        const el = ids.get(item.spid)
        return el ? [{ ...item, sourceId: el.id, targetName: el.name || el.type }] : []
      }),
      keys: slide.elements.map((el) => ({
        sourceId: el.id,
        spid: elementSpid(el),
        name: el.name || '',
      })),
      links: getSlideLinks(opened!, index).map(({ elementId, target }) => ({
        sourceId: elementId,
        target,
      })),
      runLinks: getRunLinks(opened!, index).map(({ elementId, ...rest }) => ({
        sourceId: elementId,
        ...rest,
      })),
    }
  })
  return {
    slides,
    playback,
    measurements: metrics.pendingWidthMeasurements(),
    fonts: fontList,
    fallbacks: metrics.fallbacks(),
  }
}

async function open(input: { bytes: ArrayBuffer; width: number }) {
  const faces = (await Promise.all(METRIC_FONTS.map(loadMetric))).filter((face): face is ParsedFace => !!face)
  opened = await openPptx(new Uint8Array(input.bytes))
  opened.deck.slides.forEach((_, index) => materializeSlide(opened!, index))
  embedded.clear()
  const embeddedFonts = []
  for (const face of listEmbeddedFonts(opened.archive)) {
    const id = `embed:${embedded.size}`
    embedded.set(id, face.sfnt)
    const bold = face.style === 'bold' || face.style === 'boldItalic'
    const italic = face.style === 'italic' || face.style === 'boldItalic'
    embeddedFonts.push({ id, family: face.typeface, bold, italic })
    try {
      const parsed = parseFont(
        face.sfnt.buffer.slice(face.sfnt.byteOffset, face.sfnt.byteOffset + face.sfnt.byteLength),
      )
      faces.push({
        family: face.typeface,
        bold,
        italic,
        names: [face.typeface],
        font: parsed,
      })
    } catch {
      /* The page still registers the FontFace; layout uses the metric fallback. */
    }
  }
  fontList = [
    ...METRIC_FONTS.map((font) => ({
      id: font.url,
      family: font.family,
      bold: font.bold,
      italic: font.italic,
      url: font.url,
      also: font.names.filter((name) => name !== font.family),
    })),
    ...embeddedFonts,
  ]
  metrics = createBundledMetrics(faces)
  width = input.width
  return render()
}

self.onmessage = async (event: MessageEvent) => {
  const { id, op, input } = event.data
  try {
    let result: unknown
    if (op === 'open') result = await open(input)
    else if (op === 'font') {
      const bytes = embedded.get(input)
      result = bytes ? bytes.slice().buffer : null
    } else if (op === 'measure') {
      metrics?.acceptWidthMeasurements(input)
      result = render()
    } else if (op === 'media') {
      const element = opened?.deck.slides[input.index]?.elements.find((el) => el.id === input.sourceId)
      const media = (element as { media?: { target?: string; external?: boolean; kind?: string } } | undefined)?.media
      if (!media?.target) result = null
      else if (media.external) result = { kind: media.kind, dataUrl: media.target }
      else {
        const bytes = opened!.archive.readBytes(media.target)
        const ext = media.target.split('.').pop()?.toLowerCase() || ''
        const mime: Record<string, string> = {
          mp4: 'video/mp4',
          m4v: 'video/mp4',
          mov: 'video/quicktime',
          webm: 'video/webm',
          mp3: 'audio/mpeg',
          wav: 'audio/wav',
          m4a: 'audio/mp4',
        }
        const blob = new Blob([bytes ? bytes.slice() : new Uint8Array()], { type: mime[ext] || 'application/octet-stream' })
        result = { kind: media.kind, dataUrl: URL.createObjectURL(blob) }
      }
    } else throw new Error('Unsupported read operation')
    self.postMessage({ id, result })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
