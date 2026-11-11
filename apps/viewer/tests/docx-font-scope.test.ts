import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocxFontScope } from '../src/web/docx-font-scope.ts'
import { readFileSync } from 'node:fs'

const font = { id: 'embed:0', family: 'Embedded', bold: false, italic: false }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const face = (load = async () => {}) => ({ load }) as unknown as FontFace

test('loaded embedded faces expose actual metrics, preferring regular cuts and revoking them on close', async (context) => {
  const bytes = readFileSync(
    new URL('../../../packages/ui/src/fonts/Carlito-Regular.ttf', import.meta.url),
  )
  context.mock.method(globalThis, 'fetch', async () => new Response(bytes))
  const scope = new DocxFontScope({ create: () => face(), add: () => {}, remove: () => {} })
  await scope.load(
    'http://parse',
    's',
    [{ ...font, id: 'bold', bold: true }, font],
    {},
    new AbortController().signal,
  )
  const metrics = scope.lineMetrics()
  assert.equal(metrics.length, 2)
  assert.equal(metrics[0].styled, false)
  assert.equal(metrics[0].family, font.family)
  assert.ok(metrics[0].ascent + metrics[0].descent + metrics[0].lineGap > 1)
  scope.close()
  assert.deepEqual(scope.lineMetrics(), [])
})

test('document fonts are deduplicated across recovery and only owned faces are removed', async (context) => {
  const added = new Set<FontFace>()
  const existing = face()
  added.add(existing)
  let reads = 0
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    reads++
    assert.match(url, /\/s1\/fonts\/embed%3A0$/)
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer secret')
    return new Response(new Uint8Array([1, 2]))
  })
  const scope = new DocxFontScope({
    create: () => face(),
    add: (value) => {
      added.add(value)
    },
    remove: (value) => {
      added.delete(value)
    },
  })
  const signal = new AbortController().signal
  await scope.load('http://parse/', 's1', [font, font], { Authorization: 'Bearer secret' }, signal)
  await scope.load('http://parse', 's2', [font], {}, signal)
  assert.equal(reads, 1)
  assert.equal(added.size, 2)
  scope.close()
  scope.close()
  assert.deepEqual([...added], [existing])
})

test('closing during font decoding prevents late registration', async (context) => {
  const gate = deferred()
  const decoding = deferred()
  let adds = 0
  context.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1])))
  const scope = new DocxFontScope({
    create: () =>
      face(async () => {
        decoding.resolve()
        await gate.promise
      }),
    add: () => {
      adds++
    },
    remove: () => {},
  })
  const pending = scope.load('http://parse', 's', [font], {}, new AbortController().signal)
  await decoding.promise
  scope.close()
  gate.resolve()
  await pending
  assert.equal(adds, 0)
})

test('close aborts bounded font reads and skips remaining fonts even if fetch ignores cancellation', async (context) => {
  const gate = deferred()
  const twoReads = deferred()
  const signals: AbortSignal[] = []
  let creates = 0
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal)
    if (signals.length === 2) twoReads.resolve()
    await gate.promise
    return new Response(new Uint8Array([1]))
  })
  const scope = new DocxFontScope({
    create: () => {
      creates++
      return face()
    },
    add: () => {},
    remove: () => {},
  })
  const pending = scope.load(
    'http://parse',
    's',
    Array.from({ length: 20 }, (_, id) => ({ ...font, id: String(id) })),
    {},
    new AbortController().signal,
  )
  await twoReads.promise
  scope.close()
  assert.ok(signals.every((signal) => signal.aborted))
  gate.resolve()
  await pending
  assert.equal(signals.length, 2)
  assert.equal(creates, 0)
})

test('missing fonts remain optional and can be retried on recovery', async (context) => {
  let reads = 0
  let adds = 0
  context.mock.method(globalThis, 'fetch', async () =>
    ++reads === 1 ? new Response('missing', { status: 404 }) : new Response(new Uint8Array([1])),
  )
  const scope = new DocxFontScope({
    create: () => face(),
    add: () => {
      adds++
    },
    remove: () => {},
  })
  const signal = new AbortController().signal
  await scope.load('http://parse', 's1', [font], {}, signal)
  assert.equal(adds, 0)
  await scope.load('http://parse', 's2', [font], {}, signal)
  assert.equal(adds, 1)
  scope.close()
})
