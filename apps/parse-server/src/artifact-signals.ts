/** Detach a waiter on cancellation while still observing the operation's eventual outcome. */
export function observeUntilAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    const cleanup = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', abort, { once: true })
    void work.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
  })
}
