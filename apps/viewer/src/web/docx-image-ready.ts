/** Images can be absent or broken; never let them indefinitely block pagination. */
export function waitForDocxImages(
  images: Iterable<EventTarget & { complete: boolean }>,
  signal?: AbortSignal,
  timeoutMs = 1500,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const pending = new Set([...images].filter((image) => !image.complete))
    if (!pending.size) { resolve(); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    const listeners = new Map<EventTarget, () => void>()
    let finished = false
    const finish = (aborted = false) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      for (const [image, listener] of listeners) {
        image.removeEventListener('load', listener)
        image.removeEventListener('error', listener)
      }
      listeners.clear()
      pending.clear()
      if (aborted) reject(signal!.reason)
      else resolve()
    }
    const abort = () => finish(true)
    signal?.addEventListener('abort', abort, { once: true })
    for (const image of pending) {
      const settled = () => {
        pending.delete(image)
        if (!pending.size) finish()
      }
      listeners.set(image, settled)
      image.addEventListener('load', settled, { once: true })
      image.addEventListener('error', settled, { once: true })
      // A cached image may have completed between the first check and registration.
      if (image.complete) settled()
    }
    if (!finished) timer = setTimeout(() => finish(), timeoutMs)
  })
}
