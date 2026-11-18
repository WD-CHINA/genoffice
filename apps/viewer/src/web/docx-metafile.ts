import { metafileToDataUrl, inflateMetafile } from '@genoffice/docx-engine/metafile'
import { scanMetafileFonts } from '@genoffice/viewer-services/slides/shared/metafile-fonts'
import { createPptxFontScope } from './pptx-font-scope'
import { loadElectronFonts } from './electron-font-catalog'

/** Original rasterizer and baseline faces; scope its temporary Canvas to one conversion. */
export async function convertDocxMetafile(bytes: ArrayBuffer, mime: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  // Desktop keeps the original renderer's native Canvas/font path. Android
  // needs transported baseline faces and a disposable large-Canvas owner.
  if (!/Android/i.test(navigator.userAgent)) return metafileToDataUrl(bytes, mime)
  let raw: Uint8Array = new Uint8Array(bytes)
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = await inflateMetafile(raw)
  const requests = scanMetafileFonts(raw)
  // eslint-disable-next-line no-useless-assignment -- Release inflated bytes before the large Canvas allocation.
  raw = new Uint8Array(0)
  const catalog = requests.length ? await loadElectronFonts() : []
  const fonts = catalog.filter((face) =>
    requests.some(
      (request) =>
        request.family === face.family &&
        request.bold === face.bold &&
        request.italic === face.italic,
    ),
  )
  signal?.throwIfAborted()
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    const worker = new Worker(new URL('./docx-metafile-worker.ts', import.meta.url), {
      type: 'module',
    })
    return await new Promise<string | null>((resolve, reject) => {
      const close = () => {
        worker.terminate()
        signal?.removeEventListener('abort', abort)
      }
      const abort = () => {
        close()
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      worker.onmessage = ({ data }) => {
        close()
        if (data.error) reject(new Error(data.error))
        else resolve(data.result)
      }
      worker.onerror = (error) => {
        close()
        reject(new Error(error.message || '嵌入对象预览进程失败'))
      }
      worker.postMessage({ bytes, mime, fonts }, [bytes])
    })
  }
  const scope = createPptxFontScope()
  try {
    await scope.load(
      {
        fonts,
        measurements: requests.map((request) => ({
          key: request.family,
          family: request.family,
          text: '',
          bold: request.bold,
          italic: request.italic,
        })),
      },
      async () => null,
    )
    return await metafileToDataUrl(bytes, mime)
  } finally {
    scope.close()
  }
}
