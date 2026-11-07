/** A layout dependency may hang; fallback layout can be updated when assets arrive later. */
export function waitForDocxLayout(
  ready: PromiseLike<unknown>, signal?: AbortSignal, timeoutMs = 1500,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    let finished = false
    const finish = (loaded: boolean, aborted = false) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (aborted) reject(signal!.reason)
      else resolve(loaded)
    }
    const abort = () => finish(false, true)
    const timer = setTimeout(() => finish(false), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    // Observe rejection even if a timeout or cancellation already won.
    void Promise.resolve(ready).then(() => finish(true), () => finish(false))
  })
}
