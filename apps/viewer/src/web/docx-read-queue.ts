/** Limits live response bodies too: a slot is held until JSON decoding settles. */
export class DocxReadQueue {
  private active = 0
  private readonly pending: Array<() => void> = []

  constructor(private readonly concurrency = 2, private readonly maxPending = 16) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 ||
        !Number.isSafeInteger(maxPending) || maxPending < 0)
      throw new Error('Invalid DOCX read budget')
  }

  async run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.active >= this.concurrency) {
      if (this.pending.length >= this.maxPending) throw new Error('DOCX 读取请求过多，请重试')
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          signal.removeEventListener('abort', abort)
          this.active++
          resolve()
        }
        const abort = () => {
          const index = this.pending.indexOf(start)
          if (index >= 0) this.pending.splice(index, 1)
          reject(signal.reason)
        }
        this.pending.push(start)
        signal.addEventListener('abort', abort, { once: true })
      })
    } else this.active++
    try {
      signal.throwIfAborted()
      const result = await read()
      signal.throwIfAborted()
      return result
    } finally {
      this.active--
      this.pending.shift()?.()
    }
  }
}
