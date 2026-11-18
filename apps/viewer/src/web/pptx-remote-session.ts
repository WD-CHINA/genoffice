import { readingLayoutPrefs } from './reading-position'
import {
  openServerSession,
  openingStateText,
  updateSessionLayoutPrefs,
  type PreviewNotice,
} from './server-session'
import type { PptxDeck } from './pptx-session'

/** A first frame published while the v1 asynchronous job is still building; never a complete deck. */
export interface PreviewFrame {
  deck: PptxDeck & { preview: true }
  unitsProduced: number
  unitCount: number
  complete: false
}
export interface RemoteTarget {
  server: string
  fileId: string
  token?: string
  onStatus?: (text: string) => void
  /**
   * Optional incremental first frame. The full deck still arrives through
   * `open()`; this callback only lets the UI show slide 0 before `ready`.
   */
  onPreviewFrame?: (frame: PreviewFrame) => void
  /** Metric-compatible faces bundled with the Viewer (loaded by Slides). */
  fonts?: PptxDeck['fonts']
}

interface RemoteUnit {
  slide: any
  playback: any
  measurements?: WidthItem[]
  media?: RemoteMediaRef[]
}

/** Audio/video element on the slide: the media layer plays `url` directly. */
export interface RemoteMediaRef {
  sourceId: string
  kind: 'video' | 'audio'
  url: string
}

export interface WidthItem {
  key: string
  family: string
  text: string
  bold: boolean
  italic: boolean
  kerning?: boolean
}

function mergeMeasurements(deck: PptxDeck, items: WidthItem[] | undefined) {
  if (!items?.length) return
  const merged = new Map((deck.measurements as WidthItem[]).map((item) => [item.key, item]))
  for (const item of items) merged.set(item.key, item)
  deck.measurements = [...merged.values()]
}

const EMPTY_PLAYBACK = {
  transition: 'none',
  animations: [],
  keys: [],
  links: [],
  runLinks: [],
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; code?: string }
    return body.message || body.code || `HTTP ${response.status}`
  } catch {
    return `HTTP ${response.status}`
  }
}

/**
 * The same session surface as `createPptxSession`, backed by the parse server.
 * `open` fetches the model and the first slide only; the rest of the deck is
 * filled in on demand through `loadUnit` (preview page, thumbnails, slideshow).
 */
export function createRemotePptxSession(target: RemoteTarget) {
  const base = target.server.replace(/\/+$/, '')
  let sessionId: string | null = null
  let deck: PptxDeck | undefined
  let unitCount = 0
  let closed = false
  let lastPrefAt = 0
  const abort = new AbortController()
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const units = new Map<number, RemoteUnit>()

  const authHeaders = (init?: HeadersInit): Headers => {
    const headers = new Headers(init)
    if (target.token) headers.set('Authorization', `Bearer ${target.token}`)
    return headers
  }

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: abort.signal,
      headers: authHeaders(init?.headers),
    })
    if (!response.ok) throw new Error(await readError(response))
    return (await response.json()) as T
  }

  const fetchUnit = async (index: number): Promise<RemoteUnit> => {
    const cached = units.get(index)
    if (cached) return cached
    if (!sessionId) throw new Error('Presentation is not open')
    const unit = await json<RemoteUnit>(
      `/v1/sessions/${encodeURIComponent(sessionId)}/units/${index}`,
    )
    units.set(index, unit)
    if (deck) {
      deck.slides[index] = unit.slide
      deck.playback[index] = unit.playback
    }
    return unit
  }

  let previewSent = false
  let previewDisplayed = false
  /**
   * Fetch the already-committed first unit while the shared build is still
   * running. Preview records are never cached into `units`: the ready path
   * keeps its own v1 rendering contract and remains authoritative.
   */
  const prefetchPreview = async (notice: PreviewNotice): Promise<void> => {
    if (closed || previewSent || !target.onPreviewFrame || notice.availableUnits.to < 1) return
    previewSent = true
    try {
      // `json()` already prefixes `base`; keep the root relative to it.
      const root = `${notice.endpoint}/${encodeURIComponent(notice.sessionId)}`
      const info = await json<{ model: { unitCount?: number }; fonts?: PptxDeck['fonts'] }>(
        `${root}/document`,
      )
      const first = await json<RemoteUnit>(`${root}/units/0`)
      if (closed) return
      // Build-time artifact units can still be parsed slide models. They have
      // `elements`, not the original renderer's `nodes`; keep the loading view
      // until ready rather than handing an unlaid-out model to NodeBody.
      if (!Array.isArray(first.slide?.nodes)) return
      const total = Math.max(1, notice.unitCount || info.model.unitCount || 1)
      const widthPx = Number(first.slide?.widthPx) || 960
      const heightPx = Number(first.slide?.heightPx) || 540
      // Non-placeholder blank pages keep the lazy loader from asking the server
      // for units that have not been committed yet (it would answer 202 pending).
      const blank = {
        widthPx,
        heightPx,
        nodes: [],
        background: { kind: 'solid', color: '#ffffff' },
      }
      // A malformed or pending first frame must not produce a deck that crashes
      // the viewer's playback lookups; the ready path will replace it anyway.
      const firstSlide = first.slide ?? blank
      const firstPlayback = first.playback ?? EMPTY_PLAYBACK
      const deck: PreviewFrame['deck'] = {
        slides: Array.from({ length: total }, (_, index) => (index === 0 ? firstSlide : blank)),
        playback: Array.from({ length: total }, (_, index) =>
          index === 0 ? firstPlayback : EMPTY_PLAYBACK,
        ),
        measurements: first.measurements ?? [],
        fonts: [...(target.fonts ?? []), ...(info.fonts ?? [])],
        fallbacks: [],
        media: [],
        timings: {},
        preview: true,
      }
      previewDisplayed = true
      target.onPreviewFrame({
        deck,
        unitsProduced: notice.unitsProduced,
        unitCount: total,
        complete: false,
      })
    } catch {
      // A preview is best-effort: a lost or unsupported frame must not fail open().
    }
  }

  return {
    async open(_bytes: ArrayBuffer, _width = 960): Promise<PptxDeck> {
      if (closed) throw new Error('Presentation closed')
      const created = await openServerSession<{
        sessionId: string
        model: { unitCount: number }
        fonts?: PptxDeck['fonts']
      }>({
        ...target,
        width: _width,
        ...(() => {
          const layoutPrefs = readingLayoutPrefs(target.fileId)
          return layoutPrefs ? { layoutPrefs } : {}
        })(),
        signal: abort.signal,
        onState: (state) =>
          target.onStatus?.(
            openingStateText(state === 'previewable' && !previewDisplayed ? 'building' : state),
          ),
        onPreview: (notice) => void prefetchPreview(notice),
      })
      sessionId = created.sessionId
      if (closed) {
        void fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }).catch(() => undefined)
        sessionId = null
        throw new Error('Presentation closed')
      }
      heartbeat = setInterval(() => {
        if (sessionId && !closed) {
          void json(`/v1/sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined)
        }
      }, 60_000)
      unitCount = created.model.unitCount
      if (!unitCount) throw new Error('演示文稿没有幻灯片')
      const first = await fetchUnit(0)
      const widthPx = Number(first.slide?.widthPx) || 960
      const heightPx = Number(first.slide?.heightPx) || 540
      const slides = Array.from({ length: unitCount }, (_, index) =>
        index === 0
          ? first.slide
          : {
              widthPx,
              heightPx,
              nodes: [],
              background: { kind: 'solid', color: '#ffffff' },
              placeholder: true,
            },
      )
      const playback = Array.from({ length: unitCount }, (_, index) =>
        index === 0 ? first.playback : EMPTY_PLAYBACK,
      )
      deck = {
        slides,
        playback,
        measurements: [],
        fonts: [...(target.fonts ?? []), ...(created.fonts ?? [])],
        fallbacks: [],
        media: [],
        timings: {},
      }
      mergeMeasurements(deck, first.measurements)
      return deck
    },
    /** Fetch one slide render tree; the Slides component calls this lazily. */
    async loadUnit(index: number): Promise<RemoteUnit> {
      if (index < 0 || index >= unitCount) throw new Error('幻灯片不存在')
      const unit = await fetchUnit(index)
      if (deck) mergeMeasurements(deck, unit.measurements)
      return unit
    },
    async measure(widths: Record<string, number>): Promise<PptxDeck> {
      if (!sessionId || !deck) throw new Error('Presentation is not open')
      await json(`/v1/sessions/${encodeURIComponent(sessionId)}/text-widths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
          renderRevision: 1,
          widths: Object.entries(widths).map(([key, width]) => ({ key, width })),
        }),
      })
      // The server invalidated cached render trees; refetch the slides already on screen.
      const loaded = [...units.keys()]
      units.clear()
      const measurements: WidthItem[] = []
      for (const index of loaded) {
        const unit = await fetchUnit(index)
        deck.slides[index] = unit.slide
        deck.playback[index] = unit.playback
        measurements.push(...(unit.measurements ?? []))
      }
      const merged = new Map<string, WidthItem>()
      for (const item of measurements) merged.set(item.key, item)
      // Return a new deck object: mutating the previous one makes React bail out
      // of the state update, leaving the first (heuristic) layout on screen.
      deck = {
        ...deck,
        slides: deck.slides.slice(),
        playback: deck.playback.slice(),
        measurements: [...merged.values()],
      }
      return deck
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
    /** Audio/video for a slide element; the URL is the part route (Range-capable). */
    async media(
      index: number,
      sourceId: string,
    ): Promise<{ kind: string; dataUrl: string } | null> {
      if (index < 0 || index >= unitCount) return null
      const unit = await fetchUnit(index)
      const ref = unit.media?.find((item) => item.sourceId === sourceId)
      return ref ? { kind: ref.kind, dataUrl: ref.url } : null
    },
    updateReadingPosition(page: number): void {
      if (!sessionId || closed) return
      const now = Date.now()
      if (now - lastPrefAt < 750) return
      lastPrefAt = now
      void updateSessionLayoutPrefs(base, sessionId, { page }, target.token).catch(() => undefined)
    },
    close(): void {
      closed = true
      abort.abort()
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (sessionId) {
        void fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }).catch(() => undefined)
        sessionId = null
      }
      units.clear()
      deck = undefined
    },
  }
}
