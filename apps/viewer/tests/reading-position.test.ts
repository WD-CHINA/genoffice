import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearReadingPosition, loadReadingPosition, readingLayoutPrefs, saveDocxReadingAnchor,
  saveReadingPosition,
} from '../src/web/reading-position.ts'

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    dump: () => values,
  }
}

const id = 'a'.repeat(64)
const other = 'b'.repeat(64)
const now = Date.now()

test('remembers a per-file slide position and clears it explicitly', () => {
  const storage = memory()
  assert.equal(loadReadingPosition(id, storage), undefined)
  saveReadingPosition(id, 7, storage, now)
  saveReadingPosition(other, 2, storage, now)
  assert.deepEqual(loadReadingPosition(id, storage), { page: 7, savedAt: now })
  assert.deepEqual(loadReadingPosition(other, storage), { page: 2, savedAt: now })
  assert.deepEqual(readingLayoutPrefs(id, storage), { page: 7 })
  assert.equal(readingLayoutPrefs('c'.repeat(64), storage), undefined)
  clearReadingPosition(id, storage)
  assert.equal(loadReadingPosition(id, storage), undefined)
  assert.equal(loadReadingPosition(other, storage)?.page, 2)
})

test('ignores corrupt, stale and out-of-range state instead of breaking viewing', () => {
  const storage = memory()
  storage.setItem('genoffice.reading-position.v1', '{not json')
  assert.equal(loadReadingPosition(id, storage), undefined)
  saveReadingPosition(id, 3, storage, now)
  const stale = JSON.parse(storage.getItem('genoffice.reading-position.v1')!) as Record<string, { page: number; savedAt: number }>
  stale[id].savedAt = now - 31 * 24 * 60 * 60_000
  storage.setItem('genoffice.reading-position.v1', JSON.stringify(stale))
  assert.equal(loadReadingPosition(id, storage), undefined)
  // Invalid inputs are dropped, never stored.
  saveReadingPosition(id, -1, storage, now)
  saveReadingPosition(id, 1.5 as unknown as number, storage, now)
  assert.equal(loadReadingPosition(id, storage), undefined)
  assert.equal(loadReadingPosition('not-a-file', storage), undefined)
})

test('stores DOCX source anchors and maps them to bounded layoutPrefs', () => {
  const storage = memory()
  const anchor = { unitId: '12', blockIndex: 3, offset: 48, row: 2, paragraph: 7 }
  saveDocxReadingAnchor(id, anchor, storage, now)
  assert.deepEqual(loadReadingPosition(id, storage), { anchor, savedAt: now })
  assert.deepEqual(readingLayoutPrefs(id, storage), {
    anchor: { unitId: '12', blockIndex: 3, offsetPx: 48 },
  })
  // Invalid anchors are ignored, leaving the previous entry intact.
  saveDocxReadingAnchor(id, { unitId: '', blockIndex: 0, offset: 0 }, storage, now)
  saveDocxReadingAnchor(id, { unitId: '1', blockIndex: -1, offset: 0 }, storage, now)
  assert.deepEqual(loadReadingPosition(id, storage)?.anchor, anchor)
})

test('a failing storage backend is silent', () => {
  const broken = {
    getItem: () => { throw new Error('denied') },
    setItem: () => { throw new Error('denied') },
    removeItem: () => { throw new Error('denied') },
  }
  assert.equal(loadReadingPosition(id, broken), undefined)
  assert.doesNotThrow(() => saveReadingPosition(id, 4, broken, now))
  assert.doesNotThrow(() => clearReadingPosition(id, broken))
})
