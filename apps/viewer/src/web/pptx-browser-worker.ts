import { parse as parseFont } from 'opentype.js'
import {
  openPptx,
  materializeSlide,
  listEmbeddedFonts,
  elementSpid,
  getSlideTransition,
  getSlideAnimations,
  getSlideLinks,
  getRunLinks,
} from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { createBrowserMedia, servedMedia } from './browser-media'
import { createBundledMetrics, type ParsedFace } from './bundled-metrics'
import { METRIC_FONTS, type MetricFont } from './metric-fonts'
import { createFontDemand, type AvailableFont } from './font-demand'

type Opened = Awaited<ReturnType<typeof openPptx>>

let opened: Opened | null = null
let metrics: ReturnType<typeof createBundledMetrics> | null = null
let width = 960
let fontList: Array<{
  id: string
  family: string
  bold: boolean
  italic: boolean
  url?: string
  also?: string[]
}> = []
const embedded = new Map<string, Uint8Array>()
const mediaRefs = new Map<string, string>()
const mediaResolvers = new Map<string, ReturnType<typeof createBrowserMedia>>()
let playback: unknown[] = []
let timings: Record<string, number> = {}
let rendered: any[] = []
let dependencies: Array<Set<string>> = []
let activeKeys: Set<string> | null = null

function tuneCarlito(font: {
  ascender: number
  descender: number
  lineGap?: number
  tables?: { os2?: { usWinAscent?: number; usWinDescent?: number } }
}) {
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
    return {
      family: font.family,
      bold: font.bold,
      italic: font.italic,
      names: font.names,
      font: parsed,
    }
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

function mediaResolver(path: string) {
  if (!mediaResolvers.has(path))
    mediaResolvers.set(path, createBrowserMedia(opened!, path, mediaRefs))
  return mediaResolvers.get(path)!.resolve
}

function render(patch = false) {
  if (!opened || !metrics) throw new Error('Presentation is not open')
  // one media layer for the whole deck: a part bigger than the head is described once,
  // as a descriptor, and handed to the page as bytes on request instead of base64
  const updates: Array<[number, any]> = []
  const slides = opened.deck.slides.map((slide, i) => {
    if (rendered[i]) return rendered[i]
    dependencies[i] = new Set()
    activeKeys = dependencies[i]
    try {
      const built = buildRenderSlide(slide, opened!.deck.size, {
        fitWidthPx: width,
        metrics: metrics!.provider,
        media: mediaResolver(slide.path),
        slideNo: i + 1,
      })
      rendered[i] = built
      updates.push([i, built])
      return built
    } finally {
      activeKeys = null
    }
  })
  timings.renderedSlides = (timings.renderedSlides || 0) + updates.length

  return {
    ...(patch ? { slideUpdates: updates } : { slides }),
    playback,
    measurements: metrics.pendingWidthMeasurements(),
    fonts: fontList,
    fallbacks: metrics.fallbacks(),
    media: [...mediaRefs],
    timings,
  }
}

async function open(input: { bytes: ArrayBuffer; width: number }) {
  const started = performance.now()
  mediaRefs.clear()
  mediaResolvers.clear()
  timings = {}
  opened = await openPptx(new Uint8Array(input.bytes), { hash: false })
  opened.deck.slides.forEach((_, index) => materializeSlide(opened!, index))
  embedded.clear()
  const embeddedFonts: Array<{
    id: string
    family: string
    bold: boolean
    italic: boolean
    names: string[]
  }> = []
  for (const face of listEmbeddedFonts(opened.archive)) {
    const id = `embed:${embedded.size}`
    embedded.set(id, face.sfnt)
    const bold = face.style === 'bold' || face.style === 'boldItalic'
    const italic = face.style === 'italic' || face.style === 'boldItalic'
    embeddedFonts.push({ id, family: face.typeface, bold, italic, names: [face.typeface] })
  }
  const catalog: Array<AvailableFont & { url?: string; tuneWin?: boolean }> = [
    ...METRIC_FONTS.map((font) => ({ ...font, id: font.url })),
    ...embeddedFonts,
  ]
  const parsedAt = performance.now()
  playback = opened.deck.slides.map((slide, index) => {
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
  const unavailable = new Set<string>()
  const demand = createFontDemand(catalog, unavailable)
  const parsedFaces = new Map<string, ParsedFace>()
  const attempted = new Set<string>()
  width = input.width
  let layoutMs = 0
  let fontMs = 0
  let layoutPasses = 0
  for (;;) {
    const layoutAt = performance.now()
    rendered = []
    dependencies = []
    metrics = createBundledMetrics(
      catalog.flatMap((font) => (parsedFaces.has(font.id) ? [parsedFaces.get(font.id)!] : [])),
      demand.request,
      (key) => activeKeys?.add(key),
    )
    const result = render()
    layoutMs += performance.now() - layoutAt
    layoutPasses++
    const needed = catalog.filter((font) => demand.ids().has(font.id) && !attempted.has(font.id))
    if (!needed.length) {
      fontList = catalog
        .filter((font) => attempted.has(font.id))
        .map((font) => ({
          id: font.id,
          family: font.family,
          bold: font.bold,
          italic: font.italic,
          ...(font.url ? { url: font.url } : {}),
          also: font.names.filter((name) => name !== font.family),
        }))
      timings = {
        renderedSlides: timings.renderedSlides,
        parseMs: parsedAt - started,
        fontMs,
        layoutMs,
        layoutPasses,
        loadedFonts: fontList.length,
        totalFonts: catalog.length,
        totalMs: performance.now() - started,
      }
      return { ...result, fonts: fontList, timings }
    }
    const fontsAt = performance.now()
    await Promise.all(
      needed.map(async (font) => {
        attempted.add(font.id)
        let parsed: ParsedFace | null = null
        if (font.url) parsed = await loadMetric({ ...font, url: font.url })
        else {
          const bytes = embedded.get(font.id)!
          try {
            parsed = { ...font, font: parseFont(bytes.slice().buffer) }
          } catch {
            /* The page still loads the embedded FontFace, as before. */
          }
        }
        if (parsed) parsedFaces.set(font.id, parsed)
        else unavailable.add(font.id)
      }),
    )
    fontMs += performance.now() - fontsAt
  }
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
      const keys = new Set(Object.keys(input))
      for (let index = 0; index < dependencies.length; index++)
        if ([...dependencies[index]].some((key) => keys.has(key))) rendered[index] = undefined
      result = render(true)
    } else if (op === 'bytes') {
      // raw part bytes for a descriptor the render tree carries (transferred, not copied)
      const served = opened ? servedMedia(opened, input.ref) : null
      result = served ? served.bytes.slice().buffer : null
    } else if (op === 'media') {
      const element = opened?.deck.slides[input.index]?.elements.find(
        (el) => el.id === input.sourceId,
      )
      const media = (
        element as { media?: { target?: string; external?: boolean; kind?: string } } | undefined
      )?.media
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
        const blob = new Blob([bytes ? bytes.slice() : new Uint8Array()], {
          type: mime[ext] || 'application/octet-stream',
        })
        result = { kind: media.kind, dataUrl: URL.createObjectURL(blob) }
      }
    } else throw new Error('Unsupported read operation')
    self.postMessage({ id, result }, { transfer: result instanceof ArrayBuffer ? [result] : [] })
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
