/**
 * Offline-friendly PPTX session: the parse server exports the parsed slide models and
 * the viewer lays them out here, in the browser, with the bundled metric fonts plus the
 * browser's own text-width measurements. Nothing in the layout loop talks to the server,
 * so a cached bundle renders with the same wrapping as the online viewer while offline.
 *
 * The session surface matches createPptxSession / createRemotePptxSession.
 */
import { parse as parseFont } from 'opentype.js'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { createBundledMetrics, type ParsedFace } from './bundled-metrics'
import { METRIC_FONTS } from './metric-fonts'
import type { PptxDeck } from './pptx-session'

export interface ModelTarget {
  server: string
  fileId: string
  token?: string
}

interface LayoutInfo {
  size: { cx: number; cy: number }
  slideCount: number
  fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean; also?: string[] }>
  parserVersion?: string
}

interface LayoutMediaRef {
  sourceId: string
  kind: 'video' | 'audio'
  url: string
}

interface LayoutSlide {
  slide: any
  playback: any
  /** media ref → part URL (or inline data URL) */
  media: Array<[string, string]>
  mediaRefs: LayoutMediaRef[]
  size: { cx: number; cy: number }
}

interface WidthItem {
  key: string
  family: string
  text: string
  bold: boolean
  italic: boolean
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; code?: string }
    return body.message || body.code || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

/** Carlito's Win metrics keep Office line heights; same adjustment the parse worker makes. */
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

async function metricFaces(): Promise<ParsedFace[]> {
  const faces: ParsedFace[] = []
  await Promise.all(
    METRIC_FONTS.map(async (metric) => {
      try {
        const response = await fetch(metric.url)
        if (!response.ok) return
        const font = parseFont(await response.arrayBuffer())
        if (metric.tuneWin) tuneCarlito(font)
        faces.push({
          family: metric.family,
          bold: metric.bold,
          italic: metric.italic,
          names: metric.names,
          font,
        })
      } catch {
        /* the face is simply unavailable for measuring */
      }
    }),
  )
  return faces
}

export function createModelPptxSession(target: ModelTarget) {
  const base = target.server.replace(/\/+$/, '')
  let sessionId: string | null = null
  let deck: PptxDeck | undefined
  let info: LayoutInfo | undefined
  let metrics: ReturnType<typeof createBundledMetrics> | undefined
  let widthPx = 960
  let closed = false
  const sources = new Map<number, LayoutSlide>()
  const rendered = new Map<number, { slide: any; playback: any }>()

  const authHeaders = (init?: HeadersInit): Headers => {
    const headers = new Headers(init)
    if (target.token) headers.set('Authorization', `Bearer ${target.token}`)
    return headers
  }

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, { ...init, headers: authHeaders(init?.headers) })
    if (!response.ok) throw new Error(await readError(response))
    return (await response.json()) as T
  }

  const fetchSource = async (index: number): Promise<LayoutSlide> => {
    const cached = sources.get(index)
    if (cached) return cached
    if (!sessionId) throw new Error('Presentation is not open')
    const source = await json<LayoutSlide>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/layout/slides/${index}`,
    )
    sources.set(index, source)
    return source
  }

  const build = async (index: number): Promise<{ slide: any; playback: any }> => {
    if (!metrics) throw new Error('Presentation is not open')
    const source = await fetchSource(index)
    const media = new Map(source.media)
    const slide = buildRenderSlide(source.slide, source.size as never, {
      fitWidthPx: widthPx,
      metrics: metrics.provider,
      media: (ref: string) => media.get(ref),
      slideNo: index + 1,
    })
    const unit = { slide, playback: source.playback }
    rendered.set(index, unit)
    if (deck) {
      deck.slides[index] = slide
      deck.playback[index] = source.playback
    }
    return unit
  }

  const snapshot = (): PptxDeck => {
    if (!deck || !metrics) throw new Error('Presentation is not open')
    return {
      ...deck,
      slides: deck.slides.slice(),
      playback: deck.playback.slice(),
      measurements: metrics.pendingWidthMeasurements(),
      fallbacks: metrics.fallbacks(),
    }
  }

  return {
    async open(_bytes: ArrayBuffer, width = 960): Promise<PptxDeck> {
      if (closed) throw new Error('Presentation closed')
      widthPx = width
      const created = await json<{
        sessionId: string
        model: { unitCount: number }
        fonts?: LayoutInfo['fonts']
      }>('/v1/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: target.fileId }),
      })
      sessionId = created.sessionId
      info = await json<LayoutInfo>(`/v1/sessions/${encodeURIComponent(sessionId)}/layout`)
      if (!info.slideCount) throw new Error('演示文稿没有幻灯片')

      const faces = await metricFaces()
      const embedded = info.fonts ?? created.fonts ?? []
      await Promise.all(
        embedded.map(async (font) => {
          try {
            const response = await fetch(
              `${base}/v1/sessions/${encodeURIComponent(sessionId!)}/fonts/${encodeURIComponent(font.id)}`,
              { headers: authHeaders() },
            )
            if (!response.ok) return
            faces.push({
              family: font.family,
              bold: font.bold,
              italic: font.italic,
              names: font.also ?? [],
              font: parseFont(await response.arrayBuffer()),
            })
          } catch {
            /* the page still registers the face for drawing; measuring falls back */
          }
        }),
      )
      metrics = createBundledMetrics(faces)

      const first = await build(0)
      deck = {
        slides: Array.from({ length: info.slideCount }, (_, index) =>
          index === 0
            ? first.slide
            : {
                widthPx: first.slide.widthPx,
                heightPx: first.slide.heightPx,
                nodes: [],
                background: { kind: 'solid', color: '#ffffff' },
                placeholder: true,
              },
        ),
        playback: Array.from({ length: info.slideCount }, (_, index) =>
          index === 0
            ? first.playback
            : {
                transition: 'none',
                animations: [],
                keys: [],
                links: [],
                runLinks: [],
              },
        ),
        measurements: [],
        fonts: [
          ...METRIC_FONTS.map((font) => ({
            id: font.url,
            family: font.family,
            bold: font.bold,
            italic: font.italic,
            url: font.url,
            also: font.names.filter((name) => name !== font.family),
          })),
          ...embedded.map((font) => ({
            id: font.id,
            family: font.family,
            bold: font.bold,
            italic: font.italic,
            also: font.also ?? [],
          })),
        ],
        fallbacks: [],
        media: [],
        timings: {},
      }
      return snapshot()
    },

    async loadUnit(index: number): Promise<{
      slide: any
      playback: any
      measurements: WidthItem[]
    }> {
      if (!info || index < 0 || index >= info.slideCount) throw new Error('幻灯片不存在')
      const unit = await build(index)
      return { slide: unit.slide, playback: unit.playback, measurements: [] }
    },

    /** Re-layout the loaded slides with real widths; no round trip. */
    async measure(widths: Record<string, number>): Promise<PptxDeck> {
      if (!metrics) throw new Error('Presentation is not open')
      metrics.acceptWidthMeasurements(widths)
      for (const index of [...rendered.keys()]) await build(index)
      return snapshot()
    },

    async font(id: string): Promise<ArrayBuffer | null> {
      if (!sessionId) return null
      const response = await fetch(
        `${base}/v1/sessions/${encodeURIComponent(sessionId)}/fonts/${encodeURIComponent(id)}`,
        { headers: authHeaders() },
      )
      if (!response.ok) return null
      return response.arrayBuffer()
    },

    async bytes(): Promise<ArrayBuffer | null> {
      return null
    },

    async media(
      index: number,
      sourceId: string,
    ): Promise<{ kind: string; dataUrl: string } | null> {
      if (!info) return null
      const source = await fetchSource(index)
      const ref = source.mediaRefs.find((item) => item.sourceId === sourceId)
      return ref ? { kind: ref.kind, dataUrl: ref.url } : null
    },

    close(): void {
      closed = true
      if (sessionId) {
        void fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }).catch(() => undefined)
        sessionId = null
      }
      sources.clear()
      rendered.clear()
      deck = undefined
    },
  }
}
