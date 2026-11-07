import { expect, it } from 'vitest'
import { FileLifecycle } from '../src/file-lifecycle'
import { StorageBudget } from '../src/storage-budget'
import { StorageAdmissionLeaseLostError, type SharedStorageLedger } from '../src/storage-reservations'

/** Two "processes" share one ledger but have independent local locks/state. */
class MemoryLedger implements SharedStorageLedger {
  readonly rows = new Map<string, { bytes: number; expires: number }>()
  readonly sets: Array<[string, number]> = []
  private tail: Promise<void> = Promise.resolve()
  renewResult = true
  renewCalls = 0
  constructor(readonly blockBytes = 1, readonly leaseMs = 30_000) {}

  async withExclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let unlock!: () => void
    this.tail = new Promise<void>((resolve) => { unlock = resolve })
    await previous
    try { return await work() } finally { unlock() }
  }
  async reservedBytes(): Promise<number> {
    const now = Date.now()
    let total = 0
    for (const row of this.rows.values()) if (row.expires > now) total += row.bytes
    return total
  }
  async set(id: string, bytes: number): Promise<void> {
    this.sets.push([id, bytes])
    this.rows.set(id, { bytes, expires: Date.now() + this.leaseMs })
  }
  async renew(id: string): Promise<boolean> {
    this.renewCalls++
    const row = this.rows.get(id)
    if (!row || row.expires <= Date.now() || !this.renewResult) return false
    row.expires = Date.now() + this.leaseMs
    return true
  }
  async release(id: string): Promise<void> { this.rows.delete(id) }
  async reconcile(): Promise<number> {
    const now = Date.now()
    let removed = 0
    for (const [id, row] of this.rows) if (row.expires <= now) { this.rows.delete(id); removed++ }
    return removed
  }
  async close(): Promise<void> { this.rows.clear() }
  expireAll(): void {
    for (const row of this.rows.values()) row.expires = Date.now() - 1
  }
}

function budget(ledger: MemoryLedger, limit = 100, free?: () => Promise<number>) {
  const lock = new FileLifecycle()
  return new StorageBudget(
    limit,
    async () => 0,
    (work) => lock.withFile('storage', work),
    free,
    undefined,
    { highPercent: 100, lowPercent: 100 },
    ledger,
  )
}

it('two instances cannot oversell the same quota with in-flight writes', async () => {
  const ledger = new MemoryLedger()
  const first = budget(ledger)
  const second = budget(ledger)
  const a = first.reservation()
  const b = second.reservation()
  await a.reserve(60)
  expect(await ledger.reservedBytes()).toBe(60)
  await expect(b.reserve(60)).rejects.toMatchObject({ code: 'storage_full' })
  expect(await ledger.reservedBytes()).toBe(60)
  expect(await first.sharedReservedBytes()).toBe(60)
  expect(await second.sharedReservedBytes()).toBe(60)
  await a.release()
  await b.reserve(60)
  expect(await ledger.reservedBytes()).toBe(60)
  await b.release()
  expect(await ledger.reservedBytes()).toBe(0)
})

it('rounds many small writes into shared blocks without underselling', async () => {
  const ledger = new MemoryLedger(8)
  const instance = budget(ledger, 1000)
  const lease = instance.reservation()
  for (let i = 0; i < 20; i++) await lease.reserve(1)
  expect(ledger.sets).toHaveLength(3)
  expect(ledger.sets.map(([, bytes]) => bytes)).toEqual([8, 16, 24])
  expect(lease.bytes).toBe(24)
  expect(await ledger.reservedBytes()).toBe(24)
  // Consuming the remaining spare in a block must not touch SQL.
  await lease.reserve(4)
  expect(ledger.sets).toHaveLength(3)
  await lease.reserve(1)
  expect(ledger.sets.map(([, bytes]) => bytes)).toEqual([8, 16, 24, 32])
  await lease.release()
  expect(await ledger.reservedBytes()).toBe(0)
  await expect(lease.reserve(1)).rejects.toThrow('closed')
})

it('fails closed when the shared lease was reclaimed while writing', async () => {
  const ledger = new MemoryLedger()
  const instance = budget(ledger, 1000)
  const lease = instance.reservation()
  await lease.reserve(10)
  // Another instance cleaned up the stale row after a long write pause.
  ledger.expireAll()
  await ledger.reconcile()
  await expect(lease.reserve(1)).rejects.toBeInstanceOf(StorageAdmissionLeaseLostError)
  expect(await ledger.reservedBytes()).toBe(0)
  await lease.release()
})

it('does not silently re-admit bytes when renew reports a stale row', async () => {
  const ledger = new MemoryLedger(4)
  const instance = budget(ledger, 1000)
  const lease = instance.reservation()
  await lease.reserve(5)
  expect(ledger.sets[0][1]).toBe(8)
  ledger.renewResult = false
  await expect(lease.reserve(5)).rejects.toBeInstanceOf(StorageAdmissionLeaseLostError)
  expect(await ledger.reservedBytes()).toBe(8)
  await lease.release()
  expect(await ledger.reservedBytes()).toBe(0)
})

it('release is idempotent and clears the shared row exactly once', async () => {
  const ledger = new MemoryLedger()
  const instance = budget(ledger, 1000)
  const lease = instance.reservation()
  await lease.reserve(30)
  await lease.release()
  await lease.release()
  expect(instance.reservedBytes).toBe(0)
  expect(ledger.rows.size).toBe(0)
  expect(instance.snapshot).toEqual({
    limitBytes: 1000, reservedBytes: 0, highWaterBytes: 1000, lowWaterBytes: 1000,
  })
})

it('physical free space counts every process reservation', async () => {
  const ledger = new MemoryLedger()
  let free = 100
  const available = async () => free
  const first = budget(ledger, 0, available)
  const second = budget(ledger, 0, available)
  const a = first.reservation({ temporary: true })
  const b = second.reservation({ temporary: true })
  await a.reserve(60)
  await expect(b.reserve(60)).rejects.toMatchObject({ code: 'storage_full' })
  free = 200
  await b.reserve(60)
  expect(await ledger.reservedBytes()).toBe(120)
  await a.release()
  await b.release()
})
