/** Plan §6.1: bounded disk-I/O and inflate pools in the HTTP/read process. */
export const WORK_POOL_DEFAULTS = {
  diskIoConcurrency: 32,
  inflateConcurrency: 4,
} as const

export interface PoolStats {
  limit: number
  active: number
  waiting: number
  peak: number
  peakWaiting: number
}

/**
 * FIFO counting semaphore. Callers queue instead of being rejected: a read is
 * short and already bounded by the HTTP cap, so applying backpressure is better
 * than failing a valid request.
 */
export class Semaphore {
  private active = 0
  private waiting = 0
  private peak = 0
  private peakWaiting = 0
  private readonly queue: Array<() => void> = []

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('invalid work pool limit')
  }

  get pending(): number {
    return this.waiting
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      this.waiting++
      if (this.waiting > this.peakWaiting) this.peakWaiting = this.waiting
      await new Promise<void>((resolve) => {
        this.queue.push(resolve)
      })
      this.waiting--
    }
    this.active++
    if (this.active > this.peak) this.peak = this.active
    try {
      return await task()
    } finally {
      this.active--
      const next = this.queue.shift()
      if (next) next()
    }
  }

  stats(): PoolStats {
    return {
      limit: this.limit, active: this.active, waiting: this.waiting,
      peak: this.peak, peakWaiting: this.peakWaiting,
    }
  }
}

/** Shared process-wide pools for disk reads and artifact decompression. */
export class WorkPools {
  readonly disk: Semaphore
  readonly inflate: Semaphore

  constructor(options: { diskIoConcurrency?: number; inflateConcurrency?: number } = {}) {
    this.disk = new Semaphore(options.diskIoConcurrency ?? WORK_POOL_DEFAULTS.diskIoConcurrency)
    this.inflate = new Semaphore(options.inflateConcurrency ?? WORK_POOL_DEFAULTS.inflateConcurrency)
  }

  stats(): { disk: PoolStats; inflate: PoolStats } {
    return { disk: this.disk.stats(), inflate: this.inflate.stats() }
  }
}
