import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { probePageGeometry } from '@genoffice/viewer-renderers/pdf/renderer/page-probe'
import { readPageValue } from '@genoffice/viewer-renderers/pdf/renderer/page-read'
import { buildFormCatalog } from '@genoffice/viewer-renderers/pdf/renderer/form-catalog'
import { buildHeadingOutline } from '@genoffice/viewer-renderers/pdf/renderer/heading-outline'
import { buildSearchIndex, searchInIndex } from '@genoffice/viewer-renderers/pdf/renderer/search'

const page = (n: number) => ({
  rotate: n === 3 ? 90 : 0,
  view: [10, 20, 310, 520],
  userUnit: 2,
  getViewport: () => ({ width: 300 + n, height: 500 + n }),
  getAnnotations: async () => [
    {
      id: `w${n}`,
      subtype: 'Widget',
      fieldName: `field${n}`,
      fieldType: 'Tx',
      fieldValue: String(n),
      rect: [0, 0, 20, 20],
    },
  ],
  getTextContent: async () => ({
    items: [
      { str: `Heading ${n}`, transform: [18, 0, 0, 18, 20, 400], width: 90, hasEOL: true },
      {
        str: `target body ${n} with enough small text to identify the body font`,
        transform: [10, 0, 0, 10, 20, 380],
        width: 200,
        hasEOL: true,
      },
      {
        str: 'another body line with more text',
        transform: [10, 0, 0, 10, 20, 360],
        width: 160,
        hasEOL: true,
      },
    ],
  }),
})

test('page probing preserves original indexes, good geometry and per-page failures', async () => {
  const result = await probePageGeometry({
    numPages: 3,
    getPage: async (n) => {
      if (n === 2) throw Error('page 2 damaged')
      return page(n)
    },
  })
  assert.equal(result.pages.length, 3)
  assert.deepEqual(result.failures, [{ page: 2, message: 'page 2 damaged' }])
  assert.deepEqual(result.pages[1], result.pages[0])
  assert.deepEqual(result.pages[2], {
    width: 303,
    height: 503,
    rotate: 90,
    origin: [10, 20],
    userUnit: 2,
  })
})

test('first or every bad page receives a finite fallback; invalid sizes are isolated', async () => {
  const result = await probePageGeometry({
    numPages: 3,
    getPage: async (n) => {
      if (n === 1) throw Error('first bad')
      return { ...page(n), getViewport: () => ({ width: n === 2 ? NaN : 0, height: 500 }) }
    },
  })
  assert.deepEqual(
    result.failures.map((failure) => failure.page),
    [1, 2, 3],
  )
  assert.ok(result.pages.every((geom) => geom.width === 595 && geom.height === 842))
})

test('closing during a probe stops subsequent reads and does not report cancellation as damage', async () => {
  let stop = false
  let resolve!: (value: ReturnType<typeof page>) => void
  const calls: number[] = []
  const pending = new Promise<ReturnType<typeof page>>((done) => {
    resolve = done
  })
  const probe = probePageGeometry(
    {
      numPages: 500,
      getPage: async (n) => {
        calls.push(n)
        return pending
      },
    },
    () => stop,
  )
  stop = true
  resolve(page(1))
  assert.deepEqual(await probe, { pages: [], failures: [] })
  assert.deepEqual(calls, [1])
})

test('forms, heading outline and search skip damaged pages without shifting later page numbers', async () => {
  const calls: number[] = []
  const doc = {
    numPages: 3,
    getPage: async (n: number) => {
      calls.push(n)
      if (n === 2) throw Error('known unreadable page must be skipped')
      return page(n)
    },
    getFieldObjects: async () => null,
  } as unknown as PDFDocumentProxy
  const options = {
    skipPage: (n: number) => n === 2,
    onPageError: () => assert.fail('known bad page was read again'),
  }
  const forms = await buildFormCatalog(doc, options)
  assert.deepEqual(
    forms.widgets.map((widget) => widget.pageIndex),
    [0, 2],
  )
  assert.deepEqual(forms.byPage.get(1), [])
  const outline = await buildHeadingOutline(doc, () => false, options)
  assert.deepEqual(
    outline?.map((node) => (node.dest as unknown[])[0]),
    [0, 2],
  )
  const index = await buildSearchIndex(doc, options)
  assert.equal(index.length, 3)
  assert.equal(index[1]!.text, '')
  assert.deepEqual(
    searchInIndex(index, 'target').map((hit) => hit.pageIndex),
    [0, 2],
  )
  assert.ok(!calls.includes(2))
})

test('annotation and text failures are local to auxiliary scans and keep healthy page data', async () => {
  const doc = {
    numPages: 3,
    getPage: async (n: number) =>
      n === 2
        ? {
            ...page(n),
            getAnnotations: async () => {
              throw Error('bad annotation')
            },
            getTextContent: async () => {
              throw Error('bad text')
            },
          }
        : page(n),
    getFieldObjects: async () => {
      throw Error('optional field objects')
    },
  } as unknown as PDFDocumentProxy
  const errors: number[] = []
  const options = { onPageError: (n: number) => errors.push(n) }
  assert.equal((await buildFormCatalog(doc, options)).widgets.length, 2)
  assert.equal((await buildHeadingOutline(doc, () => false, options))!.length, 2)
  assert.equal((await buildSearchIndex(doc, options))[2]!.text.includes('target'), true)
  assert.deepEqual(errors, [2, 2, 2])
  await assert.rejects(buildSearchIndex(doc), /bad text/)
})

test('cancelled auxiliary reads do not extract content, report errors or continue the scan', async () => {
  let stop = false
  let extracted = 0
  const doc = {
    getPage: async () => {
      stop = true
      return {
        getTextContent: async () => {
          extracted++
          return {}
        },
      }
    },
  } as unknown as PDFDocumentProxy
  const value = await readPageValue(doc, 1, (page) => page.getTextContent(), {
    cancelled: () => stop,
    onPageError: () => assert.fail('cancellation is not an error'),
  })
  assert.equal(value, undefined)
  assert.equal(extracted, 0)
})
