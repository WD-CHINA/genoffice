import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPptxFontScope } from '../src/web/pptx-font-scope.ts'
import type { PptxDeck } from '../src/web/pptx-session.ts'

test('font scope preserves range cascade order, loads only requested families and releases aliases', async () => {
  const priorDocument = globalThis.document
  const priorFontFace = globalThis.FontFace
  const registered: any[] = []
  const decoded: any[] = []
  let release!: () => void
  const slow = new Promise<void>((resolve) => {
    release = resolve
  })
  class Face {
    constructor(
      public family: string,
      public source: string,
      public descriptors: any,
    ) {
      decoded.push(this)
    }
    async load() {
      if (this.source.includes('base')) await slow
      return this
    }
  }
  globalThis.FontFace = Face as any
  globalThis.document = {
    fonts: {
      add: (face: any) => registered.push(face),
      delete: (face: any) => registered.splice(registered.indexOf(face), 1),
      ready: Promise.resolve(),
    },
  } as any
  const face = (id: string, family: string, descriptors = {}) => ({
    id,
    family,
    url: id,
    bold: false,
    italic: false,
    descriptors,
    also: ['Office ' + family],
  })
  const deck: Pick<PptxDeck, 'fonts' | 'measurements'> = {
    fonts: [
      face('base', 'Test'),
      face('range', 'Test', { unicodeRange: 'U+0041', sizeAdjust: '110%' }),
      face('unused', 'Other'),
    ],
    measurements: [{ key: 'a', family: 'Test', text: 'AB', bold: false, italic: false }],
  }
  const scope = createPptxFontScope()
  try {
    const loading = scope.load(deck, async () => null)
    await Promise.resolve()
    assert.ok(!decoded.some((face) => face.family === 'Other'))
    release()
    await loading
    assert.deepEqual(
      registered.map((face) => face.source),
      ['url(base)', 'url(base)', 'url(range)', 'url(range)'],
    )
    assert.equal(registered[2].descriptors.sizeAdjust, '110%')
    assert.equal(registered[2].descriptors.unicodeRange, 'U+0041')
    await scope.load(deck, async () => null)
    assert.equal(registered.length, 4)
    scope.close()
    assert.equal(registered.length, 0)
    await scope.load(deck, async () => null)
    assert.equal(registered.length, 0)
  } finally {
    scope.close()
    globalThis.document = priorDocument
    globalThis.FontFace = priorFontFace
  }
})
