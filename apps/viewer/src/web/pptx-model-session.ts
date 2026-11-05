/**
 * Offline-capable PPTX session: the parse server exports parsed slide models and a
 * Worker lays them out here with the bundled metric fonts plus the browser's own
 * text-width measurements. The main thread only fetches models and moves render trees
 * into the deck; all layout work happens in pptx-model-worker.
 */
import type { PptxDeck } from './pptx-session'
import { METRIC_FONTS } from './metric-fonts'

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

interface Unit {
  slide: any
  playback: any
  mediaRefs: LayoutMediaRef[]
}

interface UnitState {
  unit: Unit
  measurements: WidthItem[]
  fallbacks: string[]
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

function placeholder(slide: { widthPx: number; heightPx: number }) {
  return {
    widthPx: slide.widthPx,
    heightPx: slide.heightPx,
    nodes: [],
    background: { kind: 'solid', color: '#ffffff' },
    placeholder: true,
  }
}

const EMPTY_PLAYBACK = {
  transition: 'none',
  animations: [],
  keys: [],
  links: [],
  runLinks: [],
}

export function createModelPptxSession(target: ModelTarget) {
  const base = target.server.replace(/\/+$/, '')
  let sessionId: string | null = null
  let deck: PptxDeck | undefined
  let info: LayoutInfo | undefined
  let widthPx = 960
  let closed = false
  let worker: Worker | null = null
  let nextId = 0
  const requests = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  const mediaRefs = new Map<number, LayoutMediaRef[]>()
  const loaded = new Set<number>()

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

  const spawn = () => {
    worker = new Worker(new URL('./pptx-model-worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (
      event: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string }>,
    ) => {
      const task = requests.get(event.data.id)
      if (!task) return
      requests.delete(event.data.id)
      if (event.data.ok) task.resolve(event.data.result)
      else task.reject(new Error(event.data.error || 'layout worker failed'))
    }
    worker.onerror = (event) => {
      const error = new Error(event.message || 'layout worker crashed')
      for (const task of requests.values()) task.reject(error)
      requests.clear()
    }
  }

  const call = <T>(op: string, input: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (!worker || closed) return reject(new Error('Presentation closed'))
      const id = ++nextId
      requests.set(id, { resolve, reject })
      worker.postMessage({ id, op, input })
    })

  const applyUnit = (index: number, unit: Unit) => {
    if (!deck) return
    deck.slides[index] = unit.slide
    deck.playback[index] = unit.playback
    mediaRefs.set(index, unit.mediaRefs ?? [])
    loaded.add(index)
  }

  const snapshot = (): PptxDeck => {
    if (!deck) throw new Error('Presentation is not open')
    return { ...deck, slides: deck.slides.slice(), playback: deck.playback.slice() }
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

      spawn()
      const opened = await call<UnitState>('open', {
        sessionBase: `${base}/v1/sessions/${encodeURIComponent(sessionId)}`,
        token: target.token,
        width: widthPx,
        fonts: info.fonts ?? created.fonts ?? [],
      })
      const first = opened.unit
      deck = {
        slides: Array.from({ length: info.slideCount }, (_, index) =>
          index === 0 ? first.slide : { ...placeholder(first.slide), placeholder: true },
        ),
        playback: Array.from({ length: info.slideCount }, (_, index) =>
          index === 0 ? first.playback : EMPTY_PLAYBACK,
        ),
        measurements: opened.measurements,
        fonts: [
          ...METRIC_FONTS.map((font) => ({
            id: font.url,
            family: font.family,
            bold: font.bold,
            italic: font.italic,
            url: font.url,
            also: font.names.filter((name) => name !== font.family),
          })),
          ...(info.fonts ?? created.fonts ?? []).map((font) => ({
            id: font.id,
            family: font.family,
            bold: font.bold,
            italic: font.italic,
            also: font.also ?? [],
          })),
        ],
        fallbacks: opened.fallbacks,
        media: [],
        timings: {},
      }
      mediaRefs.set(0, first.mediaRefs ?? [])
      loaded.add(0)
      return snapshot()
    },

    async loadUnit(index: number): Promise<{
      slide: any
      playback: any
      measurements: WidthItem[]
    }> {
      if (!info || index < 0 || index >= info.slideCount) throw new Error('幻灯片不存在')
      const state = await call<UnitState>('unit', { index })
      applyUnit(index, state.unit)
      return {
        slide: state.unit.slide,
        playback: state.unit.playback,
        measurements: state.measurements,
      }
    },

    /** Re-lay out only the slides whose width keys changed; all in the worker. */
    async measure(widths: Record<string, number>): Promise<PptxDeck> {
      const result = await call<{
        updates: Array<[number, Unit]>
        measurements: WidthItem[]
        fallbacks: string[]
      }>('measure', { widths })
      for (const [index, unit] of result.updates) applyUnit(index, unit)
      if (deck) {
        deck.measurements = result.measurements
        deck.fallbacks = result.fallbacks
      }
      return snapshot()
    },

    /**
     * Drop render trees and parsed models for slides outside `keep`. Returns the
     * indexes that were dropped so the page can turn them back into placeholders.
     */
    async release(keep: number[]): Promise<number[]> {
      if (!worker || closed) return []
      const keepSet = new Set(keep)
      const drop = [...loaded].filter((index) => !keepSet.has(index))
      if (!drop.length) return []
      const result = await call<{ dropped: number[] }>('release', { indexes: drop })
      for (const index of result.dropped) {
        mediaRefs.delete(index)
        loaded.delete(index)
        if (deck) deck.slides[index] = { ...placeholder(deck.slides[index]), placeholder: true }
      }
      return result.dropped
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
      let refs = mediaRefs.get(index)
      if (!refs) {
        const state = await call<UnitState>('unit', { index })
        applyUnit(index, state.unit)
        refs = state.unit.mediaRefs ?? []
      }
      const ref = refs.find((item) => item.sourceId === sourceId)
      return ref ? { kind: ref.kind, dataUrl: ref.url } : null
    },

    close(): void {
      closed = true
      for (const task of requests.values()) task.reject(new Error('Presentation closed'))
      requests.clear()
      if (worker) {
        try {
          worker.postMessage({ id: ++nextId, op: 'close', input: {} })
        } catch {
          /* already gone */
        }
        worker.terminate()
        worker = null
      }
      if (sessionId) {
        void fetch(`${base}/v1/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }).catch(() => undefined)
        sessionId = null
      }
      mediaRefs.clear()
      loaded.clear()
      deck = undefined
    },
  }
}
