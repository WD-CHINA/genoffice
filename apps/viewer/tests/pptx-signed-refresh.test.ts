import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerHooks } from 'node:module'

// Vite turns font imports into URLs; mirror that asset boundary in Node tests.
const assets = registerHooks({
  load(url, context, nextLoad) {
    if (/\.(ttf|woff2)(\?url)?$/.test(url)) {
      return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
const { createModelPptxSession } = await import('../src/web/pptx-model-session.ts')
assets.deregister()

const signed = (exp: number) =>
  `http://parse/v1/files/abc/parts/ppt/media/image1.png?exp=${exp}&sig=signature`

test('a loaded slide with expired image URLs refreshes its description before reuse', async () => {
  const originalWorker = globalThis.Worker
  const originalFetch = globalThis.fetch
  const ops: string[] = []
  let future = false
  const makeUnit = () => ({
    slide: { widthPx: 960, heightPx: 540, nodes: [{ type: 'image', src: signed(future ? 9_999_999_999 : 1) }] },
    playback: {},
    mediaRefs: [],
  })
  class WorkerStub {
    static current: WorkerStub
    onmessage?: (event: { data: unknown }) => void
    onerror?: (event: unknown) => void
    constructor() { WorkerStub.current = this }
    postMessage(message: { id: number; op: string; input: unknown }) {
      ops.push(message.op)
      const reply = (result: unknown) =>
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ok: true, result } }))
      if (message.op === 'open') reply({ unit: makeUnit(), measurements: [], fallbacks: [] })
      else if (message.op === 'refresh') { future = true; reply({}) }
      else if (message.op === 'unit') reply({ unit: makeUnit(), measurements: [], fallbacks: [] })
      else if (message.op === 'release') reply({ dropped: [] })
    }
    terminate() {}
  }
  globalThis.Worker = WorkerStub as unknown as typeof Worker
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v2/capabilities')) return new Response('{}', { status: 404 })
    if (init?.method === 'POST') return new Response(JSON.stringify({ sessionId: 's', fonts: [] }))
    if (url.endsWith('/layout')) return new Response(JSON.stringify({ slideCount: 1, fonts: [] }))
    return new Response(JSON.stringify({ state: 'ready' }))
  }) as typeof fetch
  const session = createModelPptxSession({ server: 'http://parse', fileId: 'abc' })
  try {
    await session.open(new ArrayBuffer(0))
    assert.equal(future, false)
    const loaded = await session.loadUnit(0)
    assert.equal(future, true, 'refresh op must be sent before reusing a stale slide')
    assert.ok(ops.includes('refresh'))
    assert.match(JSON.stringify(loaded.slide), /exp=9999999999/)
  } finally {
    session.close()
    globalThis.Worker = originalWorker
    globalThis.fetch = originalFetch
  }
})
