import {
  elementSpid,
  listEmbeddedFonts,
  getRunLinks,
  getSlideAnimations,
  getSlideLinks,
  getSlideTransition,
  openPptx,
} from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import { FeedbackMetrics, type WidthItem } from './metrics'
import { mimeForPart } from './mime'
import { slimPptxFile } from './pptx-slim'
import { signResource } from './sign'

/** One slide as the Viewer's remote session consumes it. */
export interface PptxFontSummary {
  id: string
  family: string
  bold: boolean
  italic: boolean
  also: string[]
}

interface EmbeddedFont {
  id: string
  family: string
  bold: boolean
  italic: boolean
  bytes: Uint8Array
}

export interface PptxSlideUnit {
  slide: unknown
  playback: unknown
  /** Text widths the browser should measure to refine the next render. */
  measurements: WidthItem[]
  /**
   * Audio/video elements on this slide. The media layer streams the URL directly
   * (the part route supports Range), so a cached offline bundle can serve the same
   * unit with local URLs.
   */
  media: PptxMediaRef[]
}

export interface PptxMediaRef {
  sourceId: string
  kind: 'video' | 'audio'
  url: string
}

function partUrl(baseUrl: string, fileId: string, part: string, secret?: string): string {
  const path = part.split('/').map(encodeURIComponent).join('/')
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileId)}/parts/${path}`
  if (!secret) return url
  const { exp, sig } = signResource(secret, fileId, part)
  return `${url}?exp=${exp}&sig=${sig}`
}

/**
 * Media references that were stripped from the slim archive become URLs served
 * by the parts route; anything still in the archive (charts, embeddings) stays
 * an inline data URL for now.
 */
function createMediaResolver(
  opened: Awaited<ReturnType<typeof openPptx>>,
  mediaParts: ReadonlySet<string>,
  baseUrl: string,
  fileId: string,
  secret?: string,
) {
  const cache = new Map<string, string | undefined>()
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef)
    let url: string | undefined
    if (mediaParts.has(mediaRef)) url = partUrl(baseUrl, fileId, mediaRef, secret)
    else {
      const bytes = opened.archive.readBytes(mediaRef)
      if (bytes) {
        url = `data:${mimeForPart(mediaRef)};base64,${Buffer.from(bytes).toString('base64')}`
      }
    }
    cache.set(mediaRef, url)
    return url
  }
}

interface MediaElement {
  id: string
  children?: MediaElement[]
  media?: { kind: 'video' | 'audio'; target?: string; external?: boolean }
}

/** Audio/video refs on a slide (groups included); external targets stay as given. */
function collectMediaRefs(
  elements: MediaElement[],
  resolve: (ref: string) => string | undefined,
): PptxMediaRef[] {
  const out: PptxMediaRef[] = []
  for (const element of elements) {
    const media = element.media
    const target = media?.target
    if (media && target) {
      const url = media.external ? target : resolve(target)
      if (url) out.push({ sourceId: element.id, kind: media.kind, url })
    }
    if (element.children?.length) out.push(...collectMediaRefs(element.children, resolve))
  }
  return out
}

function buildSlideUnit(
  opened: Awaited<ReturnType<typeof openPptx>>,
  index: number,
  width: number,
  mediaParts: ReadonlySet<string>,
  baseUrl: string,
  fileId: string,
  metrics: FeedbackMetrics,
  secret?: string,
): PptxSlideUnit {
  const slide = opened.deck.slides[index]
  if (!slide) throw new Error(`pptx: slide ${index} does not exist`)
  const resolve = createMediaResolver(opened, mediaParts, baseUrl, fileId, secret)
  const built = buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx: width,
    metrics,
    media: resolve,
    slideNo: index + 1,
  })
  const ids = new Map(slide.elements.map((element) => [elementSpid(element), element]))
  const playback = {
    transition: getSlideTransition(slide),
    animations: getSlideAnimations(slide).flatMap((item) => {
      const element = ids.get(item.spid)
      return element
        ? [{ ...item, sourceId: element.id, targetName: element.name || element.type }]
        : []
    }),
    keys: slide.elements.map((element) => ({
      sourceId: element.id,
      spid: elementSpid(element),
      name: element.name || '',
    })),
    links: getSlideLinks(opened, index).map(({ elementId, target }) => ({
      sourceId: elementId,
      target,
    })),
    runLinks: getRunLinks(opened, index).map(({ elementId, ...rest }) => ({
      sourceId: elementId,
      ...rest,
    })),
  }
  return {
    slide: built,
    playback,
    measurements: metrics.pendingWidthMeasurements(),
    media: collectMediaRefs(slide.elements as MediaElement[], resolve),
  }
}

/**
 * One open PPTX deck. The parser only sees a stored-only slim archive (media
 * stripped), so opening a 1 GB deck costs the XML parts rather than the whole
 * package; slides are laid out lazily and cached.
 */
export class PptxCore {
  readonly model: DocModel
  private readonly cache = new Map<number, PptxSlideUnit>()
  private readonly metrics = new FeedbackMetrics()
  private readonly embeddedFonts: EmbeddedFont[]
  readonly fonts: PptxFontSummary[]
  private lastUsed = Date.now()

  private constructor(
    readonly id: string,
    readonly fileId: string,
    readonly width: number,
    private readonly opened: Awaited<ReturnType<typeof openPptx>>,
    private readonly mediaParts: ReadonlySet<string>,
    private readonly baseUrl: string,
    private readonly secret: string | undefined,
    parserVersion: string,
    embeddedFonts: EmbeddedFont[],
  ) {
    this.embeddedFonts = embeddedFonts
    this.fonts = embeddedFonts.map(({ id, family, bold, italic }) => ({
      id,
      family,
      bold,
      italic,
      also: [],
    }))
    const slideCount = opened.deck.slides.length
    this.model = {
      format: 'pptx',
      parserVersion,
      unitKind: 'slide',
      unitCount: slideCount,
      stagesDone: ['index', 'model', 'layout'],
      stagesPending: ['measure'],
      warnings: [],
    }
  }

  static async open(input: {
    id: string
    fileId: string
    path: string
    width: number
    parserVersion: string
    baseUrl: string
    limits: ServerLimits
    mediaSecret?: string
  }): Promise<PptxCore> {
    const slim = await slimPptxFile(input.path, input.limits)
    const opened = await openPptx(slim.bytes, { hash: false })
    const embeddedFonts: EmbeddedFont[] = listEmbeddedFonts(opened.archive).map((face, index) => ({
      id: `embed:${index}`,
      family: face.typeface,
      bold: face.style === 'bold' || face.style === 'boldItalic',
      italic: face.style === 'italic' || face.style === 'boldItalic',
      bytes: face.sfnt,
    }))
    return new PptxCore(
      input.id,
      input.fileId,
      input.width,
      opened,
      slim.mediaParts,
      input.baseUrl,
      input.mediaSecret,
      input.parserVersion,
      embeddedFonts,
    )
  }

  touch(): void {
    this.lastUsed = Date.now()
  }

  idleSince(): number {
    return this.lastUsed
  }

  units(cursor?: string, limit = 100): { items: UnitSummary[]; next?: string } {
    const total = this.opened.deck.slides.length
    const start = cursor ? Number.parseInt(cursor, 10) : 0
    if (!Number.isInteger(start) || start < 0 || start > total) {
      throw new Error('pptx: invalid unit cursor')
    }
    const end = Math.min(total, start + Math.max(1, Math.min(limit, 500)))
    const items: UnitSummary[] = []
    for (let index = start; index < end; index++) {
      items.push({ id: String(index), kind: 'slide', index, anchor: String(index) })
    }
    return { items, ...(end < total ? { next: String(end) } : {}) }
  }

  unit(unitId: string): PptxSlideUnit {
    const index = Number.parseInt(unitId, 10)
    if (!Number.isInteger(index) || index < 0 || index >= this.opened.deck.slides.length) {
      throw new Error(`pptx: unknown slide ${unitId}`)
    }
    let unit = this.cache.get(index)
    if (!unit) {
      unit = buildSlideUnit(
        this.opened,
        index,
        this.width,
        this.mediaParts,
        this.baseUrl,
        this.fileId,
        this.metrics,
        this.secret,
      )
      this.cache.set(index, unit)
    }
    this.touch()
    return unit
  }

  fontBytes(fontId: string): Uint8Array | null {
    return this.embeddedFonts.find((font) => font.id === fontId)?.bytes ?? null
  }

  pendingMeasurements(): WidthItem[] {
    return this.metrics.pendingWidthMeasurements()
  }

  /** Accept browser text widths and invalidate cached render trees. */
  acceptWidths(widths: Readonly<Record<string, number>>): void {
    this.metrics.accept(widths)
    this.cache.clear()
  }

  close(): void {
    this.cache.clear()
  }
}
