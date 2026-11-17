import assert from 'node:assert/strict'
import { test } from 'node:test'
import { residentPdfPages } from '../src/web/pdf-runtime'
import { createRenderQueue } from '@genoffice/viewer-renderers/pdf/renderer/render-budget'
import { probeOnePage } from '@genoffice/viewer-renderers/pdf/renderer/page-probe'
import { pageFormWidgets } from '@genoffice/viewer-renderers/pdf/renderer/form-catalog'

test('deep zoom-out keeps a fixed nearest-page window and jumping replaces it', () => {
  const visible = new Set(Array.from({ length: 1000 }, (_, n) => n))
  assert.deepEqual([...residentPdfPages(visible, 700)].sort(), [699, 700, 701])
  assert.deepEqual([...residentPdfPages(new Set(), 999)], [999])
  assert.deepEqual([...residentPdfPages(new Set([0, 1]), 999)], [999, 1, 0])
  assert.equal(residentPdfPages(visible, 0, () => 10000).size, 32)
  assert.equal(residentPdfPages(visible, 0, () => 4_000_000).size, 6)
})

test('render queue bounds work, cancels waiting pages and tolerates repeated release', async () => {
  const acquire = createRenderQueue(2)
  const a = new AbortController(),
    b = new AbortController(),
    c = new AbortController(),
    d = new AbortController()
  const first = await acquire(a.signal),
    second = await acquire(b.signal)
  let started = false
  const cancelled = acquire(c.signal)
  const last = acquire(d.signal).then((release) => {
    started = true
    return release
  })
  c.abort()
  assert.equal(await cancelled, null)
  await Promise.resolve()
  assert.equal(started, false)
  first!()
  const releaseLast = await last
  first!()
  releaseLast!()
  second!()
  assert.equal(await acquire(c.signal), null)
  const next = await acquire(a.signal)
  assert.ok(next)
  next()
})

test('lazy geometry reads only a requested distant page and retains failure page numbers', async () => {
  const calls: number[] = []
  const doc = {
    numPages: 1000,
    getPage: async (n: number) => {
      calls.push(n)
      if (n === 501) throw Error('damaged')
      return {
        getViewport: () => ({ width: 400, height: 600 }),
        rotate: 90,
        view: [10, 20],
        userUnit: 1,
      }
    },
  }
  const good = await probeOnePage(doc, 500)
  const bad = await probeOnePage(doc, 501, good!.geometry)
  assert.deepEqual(calls, [500, 501])
  assert.deepEqual(bad, { geometry: good!.geometry, failure: { page: 501, message: 'damaged' } })
  assert.equal(await probeOnePage(doc, 502, undefined, () => true), null)
  assert.deepEqual(calls, [500, 501])
})

test('lazy page forms retain signed appearances and original page indexes', () => {
  const widgets = pageFormWidgets(
    [
      {
        id: 'sig',
        subtype: 'Widget',
        fieldType: 'Sig',
        fieldName: 'signature',
        rect: [10, 10, 60, 40],
      },
      { subtype: 'Ink', rect: [10, 10, 60, 40] },
    ],
    499,
  )
  assert.equal(widgets.length, 1)
  assert.equal(widgets[0]!.pageIndex, 499)
  assert.equal(widgets[0]!.signed, true)
})
