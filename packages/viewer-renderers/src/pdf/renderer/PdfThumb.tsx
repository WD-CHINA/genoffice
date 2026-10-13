import {useEffect,useRef} from 'react'
import type {PDFDocumentProxy} from 'pdfjs-dist'
interface RenderTaskHandle {
  promise: Promise<unknown>
  cancel: () => void
}

interface RenderedThumb {
  doc: PDFDocumentProxy
  pageNo: number
  rotationDelta: number
  rasterW: number
}

function releaseCanvasPixels(canvas: HTMLCanvasElement): void {
  canvas.width = 0
  canvas.height = 0
}

/** Thumbnail: rendered once per (doc, page, rotation, raster width) while visible.
 *  Offscreen thumbnails release their canvas allocation and raster again when
 *  shown. rasterW only changes when a sidebar drag ends, so a resize re-rasters
 *  each visible thumb once; while dragging the canvas just CSS-stretches. */
export function PdfThumb({
  doc,
  pageNo,
  rotationDelta,
  visible,
  rasterW,
}: {
  doc: PDFDocumentProxy
  pageNo: number
  rotationDelta: number
  visible: boolean
  rasterW: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderedRef = useRef<RenderedThumb | null>(null)
  const renderSettledRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!visible) {
      renderedRef.current = null
      releaseCanvasPixels(canvas)
      return
    }
    const rendered = renderedRef.current
    if (
      rendered?.doc === doc &&
      rendered.pageNo === pageNo &&
      rendered.rotationDelta === rotationDelta &&
      rendered.rasterW === rasterW
    ) {
      return
    }
    renderedRef.current = null
    let disposed = false
    let renderTask: RenderTaskHandle | null = null
    const previousRenderSettled = renderSettledRef.current
    const renderSettled = (async () => {
      // pdf.js owns the canvas until RenderTask.promise settles, including after
      // cancel(). Never hand the same canvas to the replacement task sooner.
      await previousRenderSettled
      if (disposed) return
      try {
        const page = await doc.getPage(pageNo)
        if (disposed) return
        const rotation = (page.rotate + rotationDelta) % 360
        const scale = rasterW / page.getViewport({ scale: 1, rotation }).width
        const viewport = page.getViewport({ scale, rotation })
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        canvas.width = Math.floor(viewport.width * dpr)
        canvas.height = Math.floor(viewport.height * dpr)
        renderTask = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        })
        await renderTask.promise
        if (!disposed) renderedRef.current = { doc, pageNo, rotationDelta, rasterW }
      } catch {
        if (!disposed) renderedRef.current = null
      } finally {
        renderTask = null
      }
    })()
    renderSettledRef.current = renderSettled
    return () => {
      disposed = true
      renderTask?.cancel()
    }
  }, [doc, pageNo, rotationDelta, visible, rasterW])

  // Capture the node: React may clear canvasRef before passive unmount cleanup runs.
  useEffect(() => {
    const canvas = canvasRef.current
    return () => {
      if (canvas) releaseCanvasPixels(canvas)
    }
  }, [])

  return <canvas ref={canvasRef} style={{ width: '100%' }} />
}
