export interface ViewerPerformance {
  format: string
  stages: Record<string, { elapsedMs: number; durationMs: number }>
  worker?: Record<string, number>
}

/** Per-document diagnostics, available on the preview iframe's window. */
export function createViewerTiming(format: string) {
  const started = performance.now()
  let previous = started
  const result: ViewerPerformance = { format, stages: {} }
  ;(window as Window & { __viewerPerformance?: ViewerPerformance }).__viewerPerformance = result
  return {
    mark(name: string) {
      const now = performance.now()
      result.stages[name] = { elapsedMs: now - started, durationMs: now - previous }
      previous = now
      performance.mark(`viewer:${name}`)
    },
    worker(value?: Record<string, number>) {
      result.worker = value
    },
    onceAfterPaint(name: string) {
      if (result.stages[name]) return
      // Reserve the name before scheduling so React updates cannot record it twice.
      result.stages[name] = { elapsedMs: 0, durationMs: 0 }
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const now = performance.now()
          result.stages[name] = { elapsedMs: now - started, durationMs: now - previous }
          previous = now
          performance.mark(`viewer:${name}`)
        }),
      )
    },
  }
}
