import { afterEach, expect, it, vi } from 'vitest'
import { ArtifactCollectionService } from '../src/artifact-collection-service'
import type { GenerationSweepResult } from '../src/artifact-generation-sweeper'

const services: ArtifactCollectionService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  vi.useRealTimers()
})
const result = (hasMore = false): GenerationSweepResult => ({ examined: 1, collected: 0, protected: 1,
  young: 0, failed: 0, hasMore, stopped: false, errors: [] })
function setup() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
  const sweeper = { sweep: vi.fn(async () => result()), close: vi.fn(async () => {}) }
  const service = new ArtifactCollectionService(sweeper, { intervalMs: 1000, continuationMs: 25 })
  services.push(service)
  return { service, sweeper }
}

it('continues bounded batches promptly, then waits for the regular period', async () => {
  const { service, sweeper } = setup()
  sweeper.sweep.mockResolvedValueOnce(result(true))
  service.start()
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(sweeper.sweep).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(25)
  expect(sweeper.sweep).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(999)
  expect(sweeper.sweep).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(sweeper.sweep).toHaveBeenCalledTimes(3)
  expect(service.snapshot.passes).toBe(3)
})

it('coalesces manual requests during a pass rather than overlapping collection', async () => {
  const { service, sweeper } = setup()
  let release!: (value: GenerationSweepResult) => void
  sweeper.sweep.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  try {
    service.request()
    service.request()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sweeper.sweep).toHaveBeenCalledTimes(1)
  } finally { release(result()) }
  await vi.advanceTimersByTimeAsync(1)
  expect(sweeper.sweep).toHaveBeenCalledTimes(2)
})

it('records sanitized fatal failures and retries without leaving an unhandled rejection', async () => {
  const { service, sweeper } = setup()
  sweeper.sweep.mockRejectedValueOnce(Object.assign(new Error('sensitive details'), { code: 'ER_TEST' }))
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(service.snapshot.lastErrorCode).toBe('ER_TEST')
  expect(JSON.stringify(service.snapshot)).not.toContain('sensitive')
  await vi.advanceTimersByTimeAsync(1000)
  expect(sweeper.sweep).toHaveBeenCalledTimes(2)
  expect(service.snapshot.lastErrorCode).toBeUndefined()
})

it('close drains an active pass and cancels all future scheduling', async () => {
  const { service, sweeper } = setup()
  let release!: (value: GenerationSweepResult) => void
  sweeper.sweep.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  const closed = service.close()
  expect(service.close()).toBe(closed)
  expect(sweeper.close).toHaveBeenCalledTimes(1)
  try {
    expect(() => service.request()).toThrow('closed')
    expect(() => service.start()).toThrow('closed')
  } finally { release(result(true)); await closed }
  await vi.advanceTimersByTimeAsync(10_000)
  expect(sweeper.sweep).toHaveBeenCalledTimes(1)
})

it('candidate failures back off continuation and manual requests cannot bypass that delay', async () => {
  const { service, sweeper } = setup()
  sweeper.sweep.mockResolvedValueOnce({ ...result(true), failed: 1 })
  service.start()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(25)
  service.request()
  await vi.advanceTimersByTimeAsync(974)
  expect(sweeper.sweep).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(sweeper.sweep).toHaveBeenCalledTimes(2)
})
