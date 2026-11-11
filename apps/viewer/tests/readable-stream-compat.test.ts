import assert from 'node:assert/strict'
import test from 'node:test'
import { installReadableStreamAsyncIterator } from '../src/web/readable-stream-compat'

function legacy() {
  class LegacyStream<T> extends ReadableStream<T> {}
  Object.defineProperty(LegacyStream.prototype, Symbol.asyncIterator, {
    value: undefined,
    configurable: true,
  })
  Object.defineProperty(LegacyStream.prototype, 'values', { value: undefined, configurable: true })
  installReadableStreamAsyncIterator(LegacyStream)
  return LegacyStream
}

test('legacy streams yield all chunks and release their reader lock', async () => {
  const Stream = legacy()
  const stream = new Stream({
    start(controller) {
      controller.enqueue('a')
      controller.enqueue('b')
      controller.close()
    },
  })
  const values = []
  for await (const value of stream) values.push(value)
  assert.deepEqual(values, ['a', 'b'])
  assert.equal(stream.locked, false)
  const native = ReadableStream.prototype[Symbol.asyncIterator]
  installReadableStreamAsyncIterator()
  assert.equal(ReadableStream.prototype[Symbol.asyncIterator], native)
})

test('early iterator return cancels with its reason and unlocks the stream', async () => {
  const Stream = legacy()
  let reason
  const stream = new Stream({
    start(controller) {
      controller.enqueue(1)
    },
    cancel(value) {
      reason = value
    },
  })
  const iterator = stream[Symbol.asyncIterator]() as AsyncIterator<unknown, unknown>
  assert.deepEqual(await iterator.next(), { done: false, value: 1 })
  await iterator.return?.('closed')
  assert.equal(reason, 'closed')
  assert.equal(stream.locked, false)
})

test('preventCancel keeps unread data available after the iterator is closed', async () => {
  const Stream = legacy()
  let cancelled = false
  const stream = new Stream({
    start(controller) {
      controller.enqueue(1)
      controller.enqueue(2)
    },
    cancel() {
      cancelled = true
    },
  })
  const iterator = stream.values({ preventCancel: true })
  await iterator.next()
  await iterator.return?.()
  assert.equal(stream.locked, false)
  assert.equal(cancelled, false)
  const reader = stream.getReader()
  assert.deepEqual(await reader.read(), { done: false, value: 2 })
  reader.releaseLock()
})

test('stream and cancellation failures propagate while always releasing the lock', async () => {
  const Stream = legacy()
  const failure = new Error('stream failed')
  const stream = new Stream({
    start(controller) {
      controller.error(failure)
    },
  })
  await assert.rejects(stream[Symbol.asyncIterator]().next(), (error) => error === failure)
  assert.equal(stream.locked, false)
  const cancellation = new Stream({
    cancel() {
      throw failure
    },
  })
  await assert.rejects(cancellation[Symbol.asyncIterator]().return!(), (error) => error === failure)
  assert.equal(cancellation.locked, false)
})
