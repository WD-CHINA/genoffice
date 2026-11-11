import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createImageLoader } from '@genoffice/viewer-renderers/slides/renderer/image-loader'

test('remote EMF failure refreshes a signed URL instead of asking Image to decode EMF', async () => {
  const previousImage = globalThis.Image
  const previousFetch = globalThis.fetch
  const sources: string[] = []
  const requests: string[] = []
  class ImageStub {
    onload?: () => void
    onerror?: () => void
    set src(value: string) { sources.push(value); queueMicrotask(() => this.onload?.()) }
  }
  globalThis.Image = ImageStub as unknown as typeof Image
  globalThis.fetch = (async (url: string) => { requests.push(url); return new Response('', { status: 403 }) }) as typeof fetch
  try {
    const loader = createImageLoader(() => {}, 1, 0, 1, async () => 'https://server/a.emf?sig=new')
    loader.load(['https://server/a.emf?sig=old'])
    for (let index = 0; index < 10 && loader.pending(); index++) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(requests, ['https://server/a.emf?sig=old', 'https://server/a.emf?sig=new'])
    assert.deepEqual(sources, [])
    assert.equal(loader.pending(), 0)
    loader.dispose()
  } finally { globalThis.Image = previousImage; globalThis.fetch = previousFetch }
})
