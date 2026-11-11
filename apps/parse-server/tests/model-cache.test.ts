import { expect, it } from 'vitest'
import { ModelCache, recordBytes } from '../src/model-cache'

it('evicts least-recently-used records to stay inside the byte budget', () => {
  const cache = new ModelCache<string>(10)
  cache.set('a', 'a'.repeat(6), 6)
  cache.set('b', 'b'.repeat(6), 6)
  // 12 > 10: inserting b must evict a, not overshoot.
  expect(cache.stats()).toMatchObject({ bytes: 6, entries: 1, evictions: 1 })
  expect(cache.get('a')).toBeUndefined()
  expect(cache.get('b')).toBe('bbbbbb')
  // Recency: touching b makes a newly inserted c evict b only if b is oldest.
  cache.set('c', 'c'.repeat(6), 6)
  expect(cache.get('b')).toBeUndefined()
  expect(cache.get('c')).toBe('cccccc')
  expect(cache.stats().hits).toBe(2)
  expect(cache.stats().misses).toBe(2)
})

it('skips records that cannot fit even in an empty cache', () => {
  const cache = new ModelCache<string>(8)
  cache.set('big', 'x'.repeat(9), 9)
  expect(cache.stats()).toMatchObject({ bytes: 0, entries: 0, skipped: 1 })
  expect(cache.get('big')).toBeUndefined()
})

it('updates an existing key without double-counting bytes', () => {
  const cache = new ModelCache<string>(10)
  cache.set('a', 'a'.repeat(5), 5)
  cache.set('a', 'a'.repeat(4), 4)
  expect(cache.stats()).toMatchObject({ bytes: 4, entries: 1 })
})

it('can be disabled with a zero budget', () => {
  const cache = new ModelCache<string>(0)
  cache.set('a', 'a', 1)
  expect(cache.enabled).toBe(false)
  expect(cache.get('a')).toBeUndefined()
  expect(cache.stats()).toMatchObject({ maxBytes: 0, bytes: 0, entries: 0, hits: 0, misses: 0 })
})

it('measures JSON and binary records as held in memory', () => {
  expect(recordBytes(Buffer.from('abc'))).toBe(3)
  expect(recordBytes({ unit: '1', items: [1, 2] })).toBe(Buffer.byteLength(JSON.stringify({ unit: '1', items: [1, 2] })))
})
