import { parentPort } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import {
  openPptx,
  materializeSlide,
  listEmbeddedFonts,
  getSlideTransition,
  getSlideAnimations,
  elementSpid,
  getSlideLinks,
  getRunLinks,
} from '@genoffice/pptx-engine'
import { buildRenderSlide } from '@genoffice/pptx-render'
import {
  createSystemFontMetrics,
  registerEmbeddedFonts,
  listPrivateFontFaces,
  getPrivateFontData,
  setUserFontDir,
} from '@genoffice/viewer-services/slides/main/fonts'
import {
  shapedMetricsReady,
  pendingWidthMeasurements,
  acceptWidthMeasurements,
} from '@genoffice/viewer-services/slides/main/shaped-metrics'
import { listMetafileFonts } from '@genoffice/viewer-services/slides/main/metafile-fonts'
import { makeMediaResolver } from '@genoffice/viewer-services/slides/main/media'

let opened: Awaited<ReturnType<typeof openPptx>>
let metrics: ReturnType<typeof createSystemFontMetrics>
let width = 960
function render() {
  const slides = opened.deck.slides.map((slide, i) =>
    buildRenderSlide(slide, opened.deck.size, {
      fitWidthPx: width,
      metrics,
      media: makeMediaResolver(opened, slide.path),
      slideNo: i + 1,
    }),
  )
  const playback = opened.deck.slides.map((slide, index) => {
    const ids = new Map(slide.elements.map((el) => [elementSpid(el), el]))
    return {
      transition: getSlideTransition(slide),
      animations: getSlideAnimations(slide).flatMap((a) => {
        const el = ids.get(a.spid)
        return el ? [{ ...a, sourceId: el.id, targetName: el.name || el.type }] : []
      }),
      keys: slide.elements.map((el) => ({
        sourceId: el.id,
        spid: elementSpid(el),
        name: el.name || '',
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
  })
  return {
    slides,
    playback,
    measurements: pendingWidthMeasurements(),
    fonts: listPrivateFontFaces(),
  }
}
parentPort!.on('message', async ({ id, op, input }) => {
  try {
    let result: unknown
    if (op === 'open') {
      if (process.env.VIEWER_FONT_DIR) setUserFontDir(process.env.VIEWER_FONT_DIR)
      await shapedMetricsReady()
      opened = await openPptx(new Uint8Array(await readFile(input.path)))
      opened.deck.slides.forEach((_, i) => materializeSlide(opened, i))
      registerEmbeddedFonts(listEmbeddedFonts(opened.archive))
      metrics = createSystemFontMetrics()
      for (const font of listMetafileFonts(opened.archive))
        metrics.displayFamily?.({
          fontFamily: font.family,
          fontSizePx: 100,
          bold: font.bold,
          italic: font.italic,
        })
      width = input.width
      result = render()
    } else if (op === 'measure') {
      acceptWidthMeasurements(input)
      result = render()
    } else if (op === 'font') result = getPrivateFontData(input)
    else if (op === 'media') {
      const element = opened.deck.slides[input.index]?.elements.find(
        (el) => el.id === input.sourceId,
      )
      const media = (element as any)?.media
      if (!media?.target) result = null
      else if (media.external) result = { kind: media.kind, url: media.target }
      else
        result = {
          kind: media.kind,
          bytes: opened.archive.readBytes(media.target),
          ext: media.target.split('.').pop()?.toLowerCase(),
        }
    } else throw new Error('Unsupported read operation')
    parentPort!.postMessage({ id, result })
  } catch (e) {
    parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) })
  }
})
