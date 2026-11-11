/**
 * Offline/client-layout worker.
 *
 * The parse server exports parsed slide models; this worker lays them out with the
 * bundled metric fonts and re-lays out only the slides whose width keys changed when
 * the page reports browser-measured widths. Keeping the engine off the main thread is
 * what makes large decks scroll without long tasks; keeping per-slide dependency sets
 * is what makes the measurement rounds cheap.
 */
import { parse as parseFont } from 'opentype.js'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { createBundledMetrics, type ParsedFace } from './bundled-metrics'
import { METRIC_FONTS, type MetricFont } from './metric-fonts'
import { needsResourceRefresh, originOf } from './signed-url'

interface SessionFont {
  id: string
  family: string
  bold: boolean
  italic: boolean
  also?: string[]
}

interface LayoutMediaRef {
  sourceId: string
  kind: 'video' | 'audio'
  url: string
}

interface LayoutSlide {
  slide: any
  playback: any
  media: Array<[string, string]>
  mediaRefs?: LayoutMediaRef[]
  size: { cx: number; cy: number }
}

interface Unit {
  slide: any
  playback: any
  mediaRefs: LayoutMediaRef[]
}

interface OpenInput {
  /** …/v1/sessions/<id> — slide models and fonts are fetched from here. */
  sessionBase: string
  token?: string
  width: number
  fonts: SessionFont[]
}

let sessionBase = ''
let baseOrigin: string | undefined
let token = ''
let width = 960
let metrics: ReturnType<typeof createBundledMetrics> | null = null
/** Width keys the slide currently being built asked for. */
let activeKeys: Set<string> | null = null
const sources = new Map<number, LayoutSlide>()
const units = new Map<number, Unit>()
const dependencies = new Map<number, Set<string>>()

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
  try {
    const response = await fetch(font.url)
    if (!response.ok) return null
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
    return null
  }
}

async function loadEmbedded(font: SessionFont): Promise<ParsedFace | null> {
  try {
    const response = await fetch(
      `${sessionBase}/fonts/${encodeURIComponent(font.id)}`,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    )
    if (!response.ok) return null
    return {
      family: font.family,
      bold: font.bold,
      italic: font.italic,
      names: font.also ?? [],
      font: parseFont(await response.arrayBuffer()),
    }
  } catch {
    return null
  }
}

async function fetchSource(index: number): Promise<LayoutSlide> {
  const cached = sources.get(index)
  // Signed part URLs inside a cached slide/source expire; refetch the whole
  // description instead of handing dead URLs to the render tree.
  if (cached && !needsResourceRefresh(cached, { baseOrigin })) return cached
  if (cached) sources.delete(index)
  const response = await fetch(`${sessionBase}/layout/slides/${index}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body = (await response.json()) as { message?: string }
      message = body.message || message
    } catch {
      /* plain-text error */
    }
    throw new Error(message)
  }
  const source = (await response.json()) as LayoutSlide
  sources.set(index, source)
  return source
}

function build(index: number, source: LayoutSlide): Unit {
  if (!metrics) throw new Error('layout worker is not open')
  const media = new Map(source.media)
  activeKeys = new Set()
  try {
    const slide = buildRenderSlide(source.slide, source.size as never, {
      fitWidthPx: width,
      metrics: metrics.provider,
      media: (ref: string) => media.get(ref),
      slideNo: index + 1,
    })
    const unit = { slide, playback: source.playback, mediaRefs: source.mediaRefs ?? [] }
    units.set(index, unit)
    dependencies.set(index, activeKeys)
    return unit
  } finally {
    activeKeys = null
  }
}

async function ensureUnit(index: number): Promise<Unit> {
  const cached = units.get(index)
  if (cached) return cached
  return build(index, await fetchSource(index))
}

function measurements() {
  return metrics?.pendingWidthMeasurements() ?? []
}

function state(unit: Unit) {
  return { unit, measurements: measurements(), fallbacks: metrics?.fallbacks() ?? [] }
}

// Serialize asynchronous fetches with release/measure to prevent late fetches from
// resurrecting an evicted page or overwriting a newer layout.
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent) => {
  queue = queue.then(() => handleMessage(event))
}
async function handleMessage(event: MessageEvent) {
  const { id, op, input } = event.data as { id: number; op: string; input: any }
  try {
    let result: unknown
    if (op === 'refresh') {
      // Drop cached slide sources/units for one index; the next unit call refetches
      // fresh signed resource descriptions from the server.
      sources.delete(input.index)
      units.delete(input.index)
      dependencies.delete(input.index)
      result = {}
    } else if (op === 'open') {
      const open = input as OpenInput
      sessionBase = open.sessionBase.replace(/\/+$/, '')
      baseOrigin = originOf(sessionBase)
      token = open.token ?? ''
      width = open.width || 960
      const [metricFaces, embedded] = await Promise.all([
        Promise.all(METRIC_FONTS.map(loadMetric)),
        Promise.all((open.fonts ?? []).map(loadEmbedded)),
      ])
      const faces = [...metricFaces, ...embedded].filter((face): face is ParsedFace => !!face)
      metrics = createBundledMetrics(faces, undefined, (key) => activeKeys?.add(key))
      sources.clear()
      units.clear()
      dependencies.clear()
      result = state(await ensureUnit(0))
    } else if (op === 'unit') {
      result = state(await ensureUnit(input.index as number))
    } else if (op === 'measure') {
      if (!metrics) throw new Error('layout worker is not open')
      // Concurrent page loads may return the same measurement batch. Ignore keys
      // already settled or evicted while the browser was measuring them.
      const pendingKeys = new Set(measurements().map((item) => item.key))
      const widths = Object.fromEntries(
        Object.entries((input.widths ?? {}) as Record<string, number>).filter(([key]) =>
          pendingKeys.has(key),
        ),
      )
      metrics.acceptWidthMeasurements(widths)
      const keys = new Set(Object.keys(widths))
      const updates: Array<[number, Unit]> = []
      for (const [index, deps] of dependencies) {
        if (![...deps].some((key) => keys.has(key))) continue
        const source = sources.get(index)
        if (!source) continue
        updates.push([index, build(index, source)])
      }
      result = { updates, measurements: measurements(), fallbacks: metrics.fallbacks() }
    } else if (op === 'release') {
      const dropped: number[] = []
      for (const index of (input.indexes ?? []) as number[]) {
        if (!sources.has(index) && !units.has(index)) continue
        sources.delete(index)
        units.delete(index)
        dependencies.delete(index)
        dropped.push(index)
      }
      const retainedKeys = new Set<string>()
      for (const keys of dependencies.values()) for (const key of keys) retainedKeys.add(key)
      metrics?.retainWidthMeasurements(retainedKeys)
      result = { dropped }
    } else if (op === 'close') {
      sources.clear()
      units.clear()
      dependencies.clear()
      metrics = null
      result = true
    } else {
      throw new Error(`unknown layout worker operation: ${op}`)
    }
    self.postMessage({ id, ok: true, result })
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
