import assert from 'node:assert/strict'
import test from 'node:test'
import { combineAbortSignals } from '../src/web/abort-signals'

test('Chromium 114 fallback propagates the first abort and removes both listeners', () => {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!
  Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true })
  try {
    const a = new AbortController(),
      b = new AbortController()
    let removals = 0
    for (const signal of [a.signal, b.signal]) {
      const original = signal.removeEventListener.bind(signal)
      signal.removeEventListener = (...args: Parameters<typeof signal.removeEventListener>) => {
        removals++
        original(...args)
      }
    }
    const combined = combineAbortSignals([a.signal, b.signal])
    b.abort('cancelled')
    a.abort('late')
    assert.equal(combined.signal.reason, 'cancelled')
    assert.equal(removals, 2)
    combined.dispose()
    assert.equal(removals, 2)
    const disposed = combineAbortSignals([
      new AbortController().signal,
      new AbortController().signal,
    ])
    disposed.dispose()
    assert.equal(disposed.signal.aborted, false)
    assert.equal(combineAbortSignals([a.signal, b.signal]).signal.reason, 'late')
  } finally {
    Object.defineProperty(AbortSignal, 'any', native)
  }
})
