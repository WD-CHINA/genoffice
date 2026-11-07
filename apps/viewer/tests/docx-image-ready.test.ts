import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForDocxImages } from '../src/web/docx-image-ready.ts'

class ImageProbe extends EventTarget {
  complete = false
  removed: string[] = []
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions): void {
    this.removed.push(type)
    super.removeEventListener(type, callback, options)
  }
}

test('pagination waits for every pending image, including broken images', async () => {
  const loaded = new ImageProbe()
  const broken = new ImageProbe()
  const cached = new ImageProbe()
  cached.complete = true
  let done = false
  const pending = waitForDocxImages([loaded, broken, cached]).then(() => { done = true })
  loaded.dispatchEvent(new Event('load'))
  await Promise.resolve()
  assert.equal(done, false)
  broken.dispatchEvent(new Event('error'))
  await pending
  assert.equal(done, true)
  assert.deepEqual(loaded.removed.sort(), ['error', 'load'])
  assert.equal(cached.removed.length, 0)
})

test('deadline releases unresolved images and removes their listeners', async () => {
  const image = new ImageProbe()
  await waitForDocxImages([image], undefined, 0)
  assert.deepEqual(image.removed.sort(), ['error', 'load'])
  image.dispatchEvent(new Event('load'))
})

test('closing a document interrupts image waiting and removes listeners', async () => {
  const image = new ImageProbe()
  const controller = new AbortController()
  const pending = waitForDocxImages([image], controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await rejected
  assert.deepEqual(image.removed.sort(), ['error', 'load'])
  await assert.rejects(waitForDocxImages([], controller.signal), { name: 'AbortError' })
})
