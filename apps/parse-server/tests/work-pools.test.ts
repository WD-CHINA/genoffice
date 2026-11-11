import { expect, it } from 'vitest'
import { Semaphore, WorkPools, WORK_POOL_DEFAULTS } from '../src/work-pools'

it('bounds concurrent execution and queues the rest in FIFO order', async () => {
  const pool = new Semaphore(2)
  const started: number[] = []
  let active = 0
  let peak = 0
  const tasks = Array.from({ length: 5 }, (_, index) => pool.run(async () => {
    started.push(index)
    active++
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 10))
    active--
    return index
  }))
  expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4])
  expect(peak).toBe(2)
  expect(started.slice(0, 2)).toEqual([0, 1])
  // Three of the five tasks had to queue behind the two slots at once.
  expect(pool.stats()).toMatchObject({ limit: 2, active: 0, waiting: 0, peak: 2, peakWaiting: 3 })
})

it('releases the slot when a task throws', async () => {
  const pool = new Semaphore(1)
  await expect(pool.run(async () => {
    throw new Error('boom')
  })).rejects.toThrow('boom')
  expect(await pool.run(async () => 'ok')).toBe('ok')
  expect(pool.stats().active).toBe(0)
})

it('rejects invalid limits instead of silently uncapping work', () => {
  expect(() => new Semaphore(0)).toThrow('invalid work pool limit')
  expect(() => new Semaphore(1.5)).toThrow('invalid work pool limit')
})

it('exposes both pools with the documented defaults', () => {
  const pools = new WorkPools()
  expect(pools.stats()).toMatchObject({
    disk: { limit: WORK_POOL_DEFAULTS.diskIoConcurrency },
    inflate: { limit: WORK_POOL_DEFAULTS.inflateConcurrency },
  })
  const custom = new WorkPools({ diskIoConcurrency: 1, inflateConcurrency: 1 })
  expect(custom.stats()).toMatchObject({ disk: { limit: 1 }, inflate: { limit: 1 } })
})
