/** Shared single-instance quota for published content, artifact writes and temporary uploads. */
export class StorageFullError extends Error {
  readonly code = 'storage_full'
  constructor() {
    super('content, artifacts and reserved writes exceed available storage')
    this.name = 'StorageFullError'
  }
}
export interface StorageReservation {
  readonly bytes: number
  reserve(bytes: number): Promise<void>
  release(): Promise<void>
}
export class StorageBudget {
  private softReclaimAfter = 0
  private held = 0
  get reservedBytes(): number {
    return this.held
  }
  constructor(
    private readonly limit: number,
    private readonly usedBytes: () => Promise<number>,
    private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly freeBytes?: () => Promise<number>,
    private readonly reclaim?: (bytes: number) => Promise<void>,
    private readonly watermarks = { highPercent: 100, lowPercent: 100 },
  ) {}

  get snapshot() {
    return {
      limitBytes: this.limit,
      reservedBytes: this.held,
      highWaterBytes: Math.floor(this.limit * (this.watermarks.highPercent / 100)),
      lowWaterBytes: Math.floor(this.limit * (this.watermarks.lowPercent / 100)),
    }
  }

  pressureTarget(projected: number): number {
    if (
      this.limit <= 0 ||
      projected <= Math.floor(this.limit * (this.watermarks.highPercent / 100))
    )
      return 0
    return Math.max(0, projected - Math.floor(this.limit * (this.watermarks.lowPercent / 100)))
  }

  reservation(options: { temporary?: boolean } = {}): StorageReservation {
    let held = 0
    let closed = false
    return {
      get bytes() {
        return held
      },
      reserve: async (bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error('invalid storage reservation')
        await this.exclusive(async () => {
          if (closed) throw new Error('storage reservation is closed')
          const shortage = async () =>
            Math.max(
              0,
              !options.temporary && this.limit > 0
                ? (await this.usedBytes()) + this.held + bytes - this.limit
                : 0,
              this.freeBytes ? this.held + bytes - (await this.freeBytes()) : 0,
            )
          const needed = await shortage()
          const projected =
            !options.temporary && this.limit > 0 ? (await this.usedBytes()) + this.held + bytes : 0
          const soft = Date.now() >= this.softReclaimAfter ? this.pressureTarget(projected) : 0
          if (needed > 0 || soft > 0) {
            // Protected readers may prevent reaching the low mark. Back off soft
            // pressure scans, but never suppress a hard-cap/free-space check.
            await this.reclaim?.(Math.max(needed, this.pressureTarget(projected), soft))
            if ((await shortage()) > 0) throw new StorageFullError()
            const after =
              !options.temporary && this.limit > 0
                ? (await this.usedBytes()) + this.held + bytes
                : 0
            this.softReclaimAfter = this.pressureTarget(after) > 0 ? Date.now() + 30_000 : 0
          }
          held += bytes
          this.held += bytes
        })
      },
      release: async () => {
        await this.exclusive(async () => {
          if (closed) return
          closed = true
          this.held -= held
          held = 0
        })
      },
    }
  }
}
