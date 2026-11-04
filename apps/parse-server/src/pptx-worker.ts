import { parentPort } from 'node:worker_threads'
import { PptxCore } from './pptx-core'

interface Request {
  id: number
  op: 'open' | 'unit' | 'units' | 'widths' | 'measurements' | 'font' | 'close'
  input?: unknown
}

const port = parentPort
if (!port) throw new Error('pptx-worker must run as a worker thread')

let core: PptxCore | null = null

port.on('message', (request: Request) => {
  void (async () => {
    try {
      let result: unknown
      switch (request.op) {
        case 'open':
          core = await PptxCore.open(request.input as Parameters<typeof PptxCore.open>[0])
          result = { model: core.model, fonts: core.fonts }
          break
        case 'unit': {
          if (!core) throw new Error('presentation is not open')
          const { unitId } = request.input as { unitId: string }
          result = core.unit(unitId)
          break
        }
        case 'units': {
          if (!core) throw new Error('presentation is not open')
          const { cursor, limit } = request.input as { cursor?: string; limit?: number }
          result = core.units(cursor, limit)
          break
        }
        case 'widths': {
          if (!core) throw new Error('presentation is not open')
          const { widths } = request.input as { widths: Record<string, number> }
          core.acceptWidths(widths)
          result = { measurements: core.pendingMeasurements() }
          break
        }
        case 'measurements':
          if (!core) throw new Error('presentation is not open')
          result = core.pendingMeasurements()
          break
        case 'font': {
          if (!core) throw new Error('presentation is not open')
          const { fontId } = request.input as { fontId: string }
          result = core.fontBytes(fontId)
          break
        }
        case 'close':
          core?.close()
          core = null
          result = true
          break
        default:
          throw new Error(`unknown worker operation: ${String(request.op)}`)
      }
      port.postMessage({ id: request.id, ok: true, result })
    } catch (error) {
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: (error as { code?: string })?.code,
      })
    }
  })()
})
