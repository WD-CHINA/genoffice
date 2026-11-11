/** AbortSignal.any arrived after Chromium 114. Always release fallback listeners. */
export function combineAbortSignals(signals: readonly AbortSignal[]): {
  signal: AbortSignal
  dispose: () => void
} {
  if (signals.length === 1) return { signal: signals[0]!, dispose: () => undefined }
  if (typeof AbortSignal.any === 'function')
    return { signal: AbortSignal.any([...signals]), dispose: () => undefined }
  const controller = new AbortController()
  const listeners: Array<() => void> = []
  const dispose = () => {
    for (const remove of listeners.splice(0)) remove()
  }
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      dispose()
      break
    }
    const abort = () => {
      controller.abort(signal.reason)
      dispose()
    }
    signal.addEventListener('abort', abort, { once: true })
    listeners.push(() => signal.removeEventListener('abort', abort))
  }
  return { signal: controller.signal, dispose }
}
