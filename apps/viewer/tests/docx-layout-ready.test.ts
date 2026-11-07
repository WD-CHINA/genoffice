import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForDocxLayout } from '../src/web/docx-layout-ready.ts'

test('ready fonts proceed while failed fonts allow fallback layout', async () => {
  assert.equal(await waitForDocxLayout(Promise.resolve()), true)
  assert.equal(await waitForDocxLayout(Promise.reject(new Error('font failed'))), false)
})

test('deadline releases a permanently pending layout dependency', async () => {
  assert.equal(await waitForDocxLayout(new Promise(() => {}), undefined, 0), false)
})

test('closing cancels layout waiting without waiting for the underlying promise', async () => {
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject })
  const controller = new AbortController()
  const pending = waitForDocxLayout(ready, controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await rejected
  rejectReady(new Error('late font failure'))
  await Promise.resolve()
  await assert.rejects(waitForDocxLayout(Promise.resolve(), controller.signal), { name: 'AbortError' })
})
