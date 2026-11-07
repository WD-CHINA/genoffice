import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocxChunkCache } from '../src/web/docx-chunk-cache.ts'

test('byte pressure evicts least recently used chunks, including Unicode weights', () => {
  const cache = new DocxChunkCache<string>(24, 10)
  cache.set('a', '中文') // 8 UTF-16 bytes including JSON quotes
  cache.set('b', '🙂')
  cache.set('c', 'cc')
  assert.equal(cache.bytes, 24)
  assert.equal(cache.get('a'), '中文')
  cache.set('d', 'dd')
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), '中文')
  assert.equal(cache.size, 3)
  assert.equal(cache.bytes, 24)
})

test('entry ceiling bounds tiny chunks; oversized replacements release prior weight', () => {
  const cache = new DocxChunkCache<string>(100, 2)
  cache.set('a', '')
  cache.set('b', '')
  cache.set('c', '')
  assert.equal(cache.get('a'), undefined)
  cache.set('b', 'x'.repeat(100))
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.bytes, 4)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.bytes, 0)
})

test('disabled cache retains nothing and invalid limits are rejected', () => {
  for (const cache of [new DocxChunkCache(0), new DocxChunkCache(10, 0)]) {
    cache.set('a', { blocks: [] })
    assert.equal(cache.size, 0)
  }
  for (const limit of [-1, Infinity, NaN, 0.5])
    assert.throws(() => new DocxChunkCache(limit))
})
