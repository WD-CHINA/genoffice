import { expect, it } from 'vitest'
import { ParseQueue } from '../src/parse-queue'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('bounds running jobs and preserves FIFO without counting cache readers', async () => {
  const queue = new ParseQueue(1, 2)
  const gate = deferred()
  const order: number[] = []
  const first = queue.run(async () => {
    order.push(1)
    await gate.promise
  })
  const second = queue.run(async () => {
    order.push(2)
  })
  const third = queue.run(async () => {
    order.push(3)
  })
  await expect(queue.run(async () => undefined)).rejects.toMatchObject({ code: 'parse_queue_full' })
  expect(queue.snapshot).toEqual({ running: 1, queued: 2 })
  gate.resolve()
  await Promise.all([first, second, third])
  await queue.close()
  expect(order).toEqual([1, 2, 3])
  expect(queue.snapshot).toEqual({ running: 0, queued: 0 })
})

it('releases capacity after a rejected task and handles a zero-length queue', async () => {
  const queue = new ParseQueue(1, 0)
  await expect(
    queue.run(async () => {
      throw new Error('failure')
    }),
  ).rejects.toThrow('failure')
  await queue.run(async () => undefined)
  await queue.close()
})

it('shutdown rejects queued jobs and waits for the running job', async () => {
  const queue = new ParseQueue(1, 2)
  const gate = deferred()
  const running = queue.run(() => gate.promise)
  const queued = queue.run(async () => {
    throw new Error('must not start')
  })
  const rejected = expect(queued).rejects.toThrow('stopping')
  let closed = false
  const closing = queue.close().then(() => {
    closed = true
  })
  await rejected
  expect(closed).toBe(false)
  await expect(queue.run(async () => undefined)).rejects.toThrow('stopping')
  gate.resolve()
  await running
  await closing
  expect(closed).toBe(true)
})

it('reserves memory independently of CPU concurrency and releases it on failure', async () => {
  const queue = new ParseQueue(4, 2, 8192, 4096)
  const gate = deferred()
  const first = queue.run(() => gate.promise)
  const second = queue.run(() => gate.promise)
  let started = false
  const third = queue.run(async () => {
    started = true
    throw new Error('job failure')
  }, 1024)
  const thirdFailed = expect(third).rejects.toThrow('job failure')
  expect(queue.snapshot).toEqual({ running: 2, queued: 1 })
  expect(queue.memorySnapshot).toEqual({ reservedMb: 8192, totalMb: 8192 })
  expect(started).toBe(false)
  await expect(queue.run(async () => undefined, 8193)).rejects.toMatchObject({
    code: 'parse_memory_budget',
  })
  gate.resolve()
  await Promise.all([first, second, thirdFailed])
  await queue.close()
  expect(queue.memorySnapshot.reservedMb).toBe(0)
})

it('removes a cancelled waiting head and immediately admits the next fitting job', async () => {
  const queue = new ParseQueue(2, 2, 5120, 4096)
  const gate = deferred()
  const running = queue.run(() => gate.promise)
  const controller = new AbortController()
  const reason = new Error('lease lost while queued')
  let obsoleteStarted = false
  const obsolete = queue.run(async () => { obsoleteStarted = true }, 4096, controller.signal)
  const rejected = expect(obsolete).rejects.toBe(reason)
  let nextStarted = false
  const next = queue.run(async () => { nextStarted = true }, 1024)
  expect(queue.snapshot).toEqual({ running: 1, queued: 2 })
  controller.abort(reason)
  await rejected
  await next
  expect(nextStarted).toBe(true)
  expect(obsoleteStarted).toBe(false)
  expect(queue.memorySnapshot.reservedMb).toBe(4096)
  gate.resolve()
  await running
  await queue.close()
})

it('keeps running memory reserved until cancelled work finishes cleanup', async () => {
  const queue = new ParseQueue(1, 1)
  const gate = deferred()
  const started = deferred()
  const controller = new AbortController()
  const reason = new Error('lease lost in worker')
  const running = queue.run(async () => { started.resolve(); await gate.promise; return 'stale result' }, 4096, controller.signal)
  const rejected = expect(running).rejects.toBe(reason)
  await started.promise
  controller.abort(reason)
  let nextStarted = false
  const next = queue.run(async () => { nextStarted = true })
  expect(queue.snapshot).toEqual({ running: 1, queued: 1 })
  expect(queue.memorySnapshot.reservedMb).toBe(4096)
  expect(nextStarted).toBe(false)
  gate.resolve()
  await rejected
  await next
  await queue.close()
  expect(nextStarted).toBe(true)
  expect(queue.memorySnapshot.reservedMb).toBe(0)
})

it('pre-aborted and immediately cancelled admissions never invoke work', async () => {
  const queue = new ParseQueue(1, 0)
  const controller = new AbortController()
  const reason = new Error('cancelled')
  let starts = 0
  const admitted = queue.run(async () => { starts++ }, 4096, controller.signal)
  controller.abort(reason)
  await expect(admitted).rejects.toBe(reason)
  await expect(queue.run(async () => { starts++ }, 4096, controller.signal)).rejects.toBe(reason)
  expect(starts).toBe(0)
  expect(queue.snapshot).toEqual({ running: 0, queued: 0 })
  await queue.close()
})
