import { randomUUID } from 'node:crypto'
import {
  StorageAdmissionLeaseLostError,
  type SharedStorageLedger,
} from './storage-reservations'

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
  private readonly exclusive: <T>(work: () => Promise<T>) => Promise<T>
  get reservedBytes(): number {
    return this.held
  }
  constructor(
    private readonly limit: number,
    private readonly usedBytes: () => Promise<number>,
    exclusive: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly freeBytes?: () => Promise<number>,
    private readonly reclaim?: (bytes: number) => Promise<void>,
    private readonly watermarks = { highPercent: 100, lowPercent: 100 },
    private readonly shared?: SharedStorageLedger,
  ) {
    // The process lock still serializes local callers; the shared lock additionally
    // fences the read-check-publish sequence against every other process.
    this.exclusive = shared
      ? <T>(work: () => Promise<T>) => shared.withExclusive(() => exclusive(work))
      : exclusive
  }

  get snapshot() {
    return {
      limitBytes: this.limit,
      reservedBytes: this.held,
      highWaterBytes: Math.floor(this.limit * (this.watermarks.highPercent / 100)),
      lowWaterBytes: Math.floor(this.limit * (this.watermarks.lowPercent / 100)),
    }
  }

  /** Bytes fenced by all processes, including writes not yet visible on disk. */
  async sharedReservedBytes(): Promise<number> {
    return this.shared ? this.shared.reservedBytes() : this.held
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
    const shared = this.shared
    const id = shared ? randomUUID() : undefined
    let held = 0
    /** Absolute bytes recorded in the shared ledger; always >= held. */
    let committed = 0
    let closed = false
    let leaseLost = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    if (shared && id) {
      heartbeat = setInterval(() => {
        void shared.withExclusive(async () => {
          if (closed || leaseLost) return
          if (!await shared.renew(id)) leaseLost = true
        }).catch(() => { leaseLost = true })
      }, Math.max(1000, Math.floor(shared.leaseMs / 3)))
      heartbeat.unref?.()
    }
    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
    }
    return {
      get bytes() {
        return shared ? committed : held
      },
      reserve: async (bytes) => {
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error('invalid storage reservation')
        await this.exclusive(async () => {
          if (closed) throw new Error('storage reservation is closed')
          if (leaseLost) throw new StorageAdmissionLeaseLostError()
          // Small chunks spend a block of pre-admitted quota instead of a SQL
          // round trip each. Rounding up can only ever over-reserve.
          const spare = shared ? committed - held : 0
          const deficit = Math.max(0, bytes - spare)
          const incoming = shared
            ? deficit > 0
              ? Math.max(shared.blockBytes, Math.ceil(deficit / shared.blockBytes) * shared.blockBytes)
              : 0
            : bytes
          const accounted = shared ? incoming : bytes
          const globalHeld = shared ? await shared.reservedBytes() : this.held
          const shortage = async () =>
            Math.max(
              0,
              !options.temporary && this.limit > 0
                ? (await this.usedBytes()) + globalHeld + accounted - this.limit
                : 0,
              this.freeBytes ? globalHeld + accounted - (await this.freeBytes()) : 0,
            )
          const needed = await shortage()
          const projected =
            !options.temporary && this.limit > 0
              ? (await this.usedBytes()) + globalHeld + accounted
              : 0
          const soft = Date.now() >= this.softReclaimAfter ? this.pressureTarget(projected) : 0
          if (needed > 0 || soft > 0) {
            // Protected readers may prevent reaching the low mark. Back off soft
            // pressure scans, but never suppress a hard-cap/free-space check.
            await this.reclaim?.(Math.max(needed, this.pressureTarget(projected), soft))
            if ((await shortage()) > 0) throw new StorageFullError()
            const after =
              !options.temporary && this.limit > 0
                ? (await this.usedBytes()) + globalHeld + accounted
                : 0
            this.softReclaimAfter = this.pressureTarget(after) > 0 ? Date.now() + 30_000 : 0
          }
          if (shared && id) {
            if (incoming > 0) {
              // A reclaimed row means another process may already have spent
              // this reservation's bytes; never silently re-admit them.
              if (committed > 0 && !await shared.renew(id)) {
                leaseLost = true
                throw new StorageAdmissionLeaseLostError()
              }
              await shared.set(id, committed + incoming)
              committed += incoming
              this.held += incoming
            }
          } else this.held += bytes
          held += bytes
        })
      },
      release: async () => {
        stopHeartbeat()
        await this.exclusive(async () => {
          if (closed) return
          closed = true
          if (shared && id) {
            await shared.release(id).catch(() => undefined)
            this.held -= committed
            committed = 0
          } else this.held -= held
          held = 0
        })
      },
    }
  }
}
