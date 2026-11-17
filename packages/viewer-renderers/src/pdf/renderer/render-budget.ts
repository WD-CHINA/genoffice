/** Viewer-only scheduling: the main PDF renderer has no cancellable render queue. */
export function createRenderQueue(limit = 2) {
  let running = 0
  const waiting: (() => void)[] = []
  return (signal: AbortSignal): Promise<(() => void) | null> =>
    new Promise((resolve) => {
      const cancel = () => {
        const index = waiting.indexOf(start)
        if (index >= 0) waiting.splice(index, 1)
        signal.removeEventListener('abort', cancel)
        resolve(null)
      }
      const start = () => {
        signal.removeEventListener('abort', cancel)
        if (signal.aborted) {
          resolve(null)
          return
        }
        running++
        let released = false
        resolve(() => {
          if (released) return
          released = true
          running--
          waiting.shift()?.()
        })
      }
      if (signal.aborted) resolve(null)
      else if (running < limit) start()
      else {
        waiting.push(start)
        signal.addEventListener('abort', cancel, { once: true })
      }
    })
}

export const acquirePdfRender = createRenderQueue()

/** Same backing-store release as apps/pdf/src/renderer/PdfThumb.tsx. */
export function releasePdfCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0
  canvas.height = 0
}
