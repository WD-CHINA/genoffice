import { ArtifactGenerations } from './artifact-generations'
import { parentPort } from './worker-channel'
import { buildRenderSlide } from '@genoffice/pptx-render'
import { ArtifactStore, type ArtifactReader } from './artifact-store'
import { FeedbackMetrics } from './metrics'
import { refreshDocxResourceUrls } from './resource-urls'
import type { PptxLayoutSlide } from './pptx-core'

const port = parentPort
if (!port) throw new Error('artifact renderer requires an isolated process')
let reader: ArtifactReader | null = null
let input: { fileId: string; baseUrl: string; mediaSecret?: string; width: number }
let metrics = new FeedbackMetrics()
// Serial processing avoids text-width feedback racing asynchronous disk reads.
let queue = Promise.resolve()
port.on('message', (request: { id: number; op: string; input: any }) => {
  queue = queue.then(async () => {
    try {
      let result: unknown
      if (request.op === 'open') {
        input = request.input
        if (request.input.generation) {
          if (request.input.generation.key !== request.input.artifactKey) throw new Error('generation key mismatch')
          reader = await new ArtifactGenerations(request.input.artifactRoot).open(request.input.generation)
        } else reader = await new ArtifactStore(request.input.artifactRoot).find(request.input.artifactKey)
        if (!reader) throw new Error('parsed artifact is missing')
        metrics = new FeedbackMetrics()
        metrics.restore(request.input.measuredWidths ?? {})
        result = await reader.read('document')
      } else {
        if (!reader) throw new Error('artifact renderer is not open')
        if (request.op === 'unit') {
          const id = request.input.unitId as string
          if (!/^(0|[1-9]\d*)$/.test(id)) throw new Error('unknown slide')
          const source = refreshDocxResourceUrls(
            await reader.read(`unit:${id}`),
            input.fileId,
            input.baseUrl,
            input.mediaSecret,
          ) as PptxLayoutSlide
          const media = new Map(source.media)
          result = {
            slide: buildRenderSlide(source.slide as never, source.size as never, {
              fitWidthPx: input.width,
              metrics,
              slideNo: Number(id) + 1,
              media: (ref: string) => media.get(ref),
            }),
            playback: source.playback,
            media: source.mediaRefs ?? [],
            measurements: metrics.pendingWidthMeasurements(),
          }
        } else if (request.op === 'widths') {
          metrics.accept(request.input.widths)
          result = { measurements: metrics.pendingWidthMeasurements() }
        } else if (request.op === 'close') {
          reader = null
          result = true
        } else throw new Error(`unsupported artifact renderer operation: ${request.op}`)
      }
      port.postMessage({ id: request.id, ok: true, result })
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
})
