import { expect, it } from 'vitest'
import { StorageBudget } from '../src/storage-budget'
import { FileLifecycle } from '../src/file-lifecycle'

function setup(limit = 100, used = 0, free = 1000) {
  const lock = new FileLifecycle()
  const budget = new StorageBudget(
    limit,
    async () => used,
    (work) => lock.withFile('storage', work),
    async () => free,
  )
  return budget
}
it('concurrent builders cannot spend the same remaining quota and release is idempotent', async () => {
  const budget = setup(100, 40)
  const a = budget.reservation()
  const b = budget.reservation()
  const results = await Promise.allSettled([a.reserve(40), b.reserve(40)])
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(budget.reservedBytes).toBe(40)
  await a.release()
  await a.release()
  await b.release()
  expect(budget.reservedBytes).toBe(0)
  await expect(a.reserve(1)).rejects.toThrow('closed')
})
it('physical free space still limits writes when the configured quota is disabled', async () => {
  const budget = setup(0, 0, 10)
  const reservation = budget.reservation()
  await reservation.reserve(8)
  await expect(reservation.reserve(3)).rejects.toMatchObject({ code: 'storage_full' })
  expect(budget.reservedBytes).toBe(8)
  await reservation.release()
  expect(budget.reservedBytes).toBe(0)
})

it('crossing high water reclaims to low water and avoids another scan for a small write', async () => {
  const lock = new FileLifecycle()
  let used = 850
  const reclaimed: number[] = []
  const budget = new StorageBudget(
    1000,
    async () => used,
    (work) => lock.withFile('storage', work),
    undefined,
    async (bytes) => {
      reclaimed.push(bytes)
      used -= bytes
    },
    { highPercent: 90, lowPercent: 80 },
  )
  const lease = budget.reservation()
  await lease.reserve(60)
  expect(reclaimed).toEqual([110])
  expect(used + budget.reservedBytes).toBe(800)
  await lease.reserve(1)
  expect(reclaimed).toHaveLength(1)
  expect(budget.snapshot).toEqual({
    limitBytes: 1000,
    reservedBytes: 61,
    highWaterBytes: 900,
    lowWaterBytes: 800,
  })
  await lease.release()
})

it('protected cache backoff never permits a write beyond the hard cap', async () => {
  const lock = new FileLifecycle()
  let scans = 0
  const budget = new StorageBudget(
    1000,
    async () => 910,
    (work) => lock.withFile('storage', work),
    undefined,
    async () => {
      scans++
    },
    { highPercent: 90, lowPercent: 80 },
  )
  const lease = budget.reservation()
  await lease.reserve(1)
  await lease.reserve(1)
  expect(scans).toBe(1)
  await expect(lease.reserve(200)).rejects.toMatchObject({ code: 'storage_full' })
  expect(scans).toBe(2)
  expect(lease.bytes).toBe(2)
  await lease.release()
})
