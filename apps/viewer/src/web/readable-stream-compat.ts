/** PDF.js text extraction uses async iteration, absent in Android Chromium 114. */
export function installReadableStreamAsyncIterator(
  Stream: { prototype: ReadableStream } = globalThis.ReadableStream,
): void {
  if (!Stream || typeof Stream.prototype[Symbol.asyncIterator] === 'function') return
  const prototype = Stream.prototype
  if (typeof prototype.values !== 'function') {
    Object.defineProperty(prototype, 'values', {
      configurable: true,
      writable: true,
      value: function <T>(this: ReadableStream<T>, options: { preventCancel?: boolean } = {}) {
        const reader = this.getReader()
        let done = false
        let pending = Promise.resolve()
        const enqueue = <R>(action: () => Promise<R>): Promise<R> => {
          const result = pending.then(action)
          pending = result.then(
            () => undefined,
            () => undefined,
          )
          return result
        }
        return {
          next: () =>
            enqueue(async () => {
              if (done) return { done: true as const, value: undefined }
              try {
                const result = await reader.read()
                if (result.done) {
                  done = true
                  reader.releaseLock()
                }
                return result
              } catch (error) {
                done = true
                reader.releaseLock()
                throw error
              }
            }),
          return: (value?: unknown) =>
            enqueue(async () => {
              if (!done) {
                done = true
                try {
                  if (!options.preventCancel) await reader.cancel(value)
                } finally {
                  reader.releaseLock()
                }
              }
              return { done: true as const, value }
            }),
          [Symbol.asyncIterator]() {
            return this
          },
        }
      },
    })
  }
  Object.defineProperty(prototype, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: prototype.values,
  })
}
