import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocxReadQueue } from '../src/web/docx-read-queue.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('cancellation removes queued reads, while decoding retains its live slot', async () => {
  const queue = new DocxReadQueue(1, 1)
  const active = new AbortController()
  const gate = deferred()
  let started = 0
  const first = queue.run(active.signal, async () => {
    started++
    await gate.promise // A decoder that ignores cancellation still holds its slot.
    return 'stale'
  })
  const rejectedFirst = assert.rejects(first, { name: 'AbortError' })
  active.abort()
  const queued = new AbortController()
  const second = queue.run(queued.signal, async () => { started++; return 'obsolete' })
  const rejectedSecond = assert.rejects(second, { name: 'AbortError' })
  await assert.rejects(queue.run(new AbortController().signal, async () => 'overflow'), /请求过多/)
  queued.abort()
  await rejectedSecond
  const latest = queue.run(new AbortController().signal, async () => { started++; return 'latest' })
  assert.equal(started, 1)
  gate.resolve()
  await rejectedFirst
  assert.equal(await latest, 'latest')
  assert.equal(started, 2)
})

test('read and decode failures release slots; invalid budgets fail immediately', async () => {
  const queue = new DocxReadQueue(1)
  const signal = new AbortController().signal
  await assert.rejects(queue.run(signal, async () => { throw new Error('bad JSON') }), /bad JSON/)
  assert.equal(await queue.run(signal, async () => 1), 1)
  for (const value of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => new DocxReadQueue(value))
  assert.throws(() => new DocxReadQueue(1, -1))
})
