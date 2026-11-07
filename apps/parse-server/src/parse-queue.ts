export class ParseQueueFullError extends Error {
  readonly code = 'parse_queue_full'
  constructor() {
    super('parse queue is full; retry later')
  }
}

interface Waiting {
  run(): void
  reject(error: unknown): void
  memoryMb: number
}

/** Bounded FIFO for unique artifact builds. Cache hits and shared waiters never enter it. */
export class ParseQueue {
  private active = 0
  private reservedMb = 0
  private waiting: Waiting[] = []
  private stopped = false
  private idleWaiters: Array<() => void> = []

  constructor(
    readonly concurrency: number,
    readonly maxQueued: number,
    readonly totalMemoryMb = 8192,
    readonly defaultJobMemoryMb = 4096,
  ) {
    if (
      !Number.isSafeInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isSafeInteger(maxQueued) ||
      maxQueued < 0 ||
      !Number.isSafeInteger(totalMemoryMb) ||
      totalMemoryMb < 1 ||
      !Number.isSafeInteger(defaultJobMemoryMb) ||
      defaultJobMemoryMb < 1 ||
      defaultJobMemoryMb > totalMemoryMb
    )
      throw new Error('invalid parse queue limits')
  }

  get snapshot(): { running: number; queued: number } {
    return { running: this.active, queued: this.waiting.length }
  }

  get memorySnapshot(): { reservedMb: number; totalMb: number } {
    return { reservedMb: this.reservedMb, totalMb: this.totalMemoryMb }
  }

  private canStart(memoryMb: number): boolean {
    return this.active < this.concurrency && this.reservedMb + memoryMb <= this.totalMemoryMb
  }

  run<T>(work: () => Promise<T>, memoryMb = this.defaultJobMemoryMb, signal?: AbortSignal): Promise<T> {
    try {
      return this.submit(work, memoryMb, signal).done
    } catch (error) {
      return Promise.reject(error)
    }
  }

  submit<T>(work: () => Promise<T>, memoryMb = this.defaultJobMemoryMb, signal?: AbortSignal): { done: Promise<T> } {
    signal?.throwIfAborted()
    if (this.stopped) throw new Error('parse queue is stopping')
    if (!Number.isSafeInteger(memoryMb) || memoryMb < 1 || memoryMb > this.totalMemoryMb) {
      throw Object.assign(new Error('job exceeds total parse memory budget'), {
        code: 'parse_memory_budget',
      })
    }
    if (
      (!this.canStart(memoryMb) || this.waiting.length > 0) &&
      this.waiting.length >= this.maxQueued
    )
      throw new ParseQueueFullError()
    const done = new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', cancel)
      const rejectWaiting = (error: unknown) => { cleanup(); reject(error) }
      const cancel = () => {
        const index = this.waiting.indexOf(item)
        if (index < 0) return // Running work owns its cleanup and memory until it settles.
        this.waiting.splice(index, 1)
        rejectWaiting(signal!.reason)
        this.drain()
      }
      const run = () => {
        cleanup()
        this.active++
        this.reservedMb += memoryMb
        const finish = () => {
          this.active--
          this.reservedMb -= memoryMb
          this.drain()
          if (!this.active) this.idleWaiters.splice(0).forEach((done) => done())
        }
        void Promise.resolve()
          .then(() => { signal?.throwIfAborted(); return work() })
          .then(
            (value) => {
              finish()
              if (signal?.aborted) reject(signal.reason)
              else resolve(value)
            },
            (error) => {
              finish()
              reject(error)
            },
          )
      }
      const item: Waiting = { run, reject: rejectWaiting, memoryMb }
      if (this.canStart(memoryMb) && !this.waiting.length) run()
      else {
        this.waiting.push(item)
        signal?.addEventListener('abort', cancel, { once: true })
      }
    })
    return { done }
  }

  private drain(): void {
    while (!this.stopped && this.waiting[0] && this.canStart(this.waiting[0].memoryMb))
      this.waiting.shift()!.run()
  }

  /** Reject queued builds, then wait for running builds to release their workers. */
  async close(): Promise<void> {
    this.stopped = true
    this.waiting.splice(0).forEach((item) => item.reject(new Error('parse queue is stopping')))
    if (this.active) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }
}
