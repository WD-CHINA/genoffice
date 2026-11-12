import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModelSession, workerProbe } from './helpers/session-probes.ts'

const { createModelPptxSession } = await loadModelSession()

const signed = (exp: number) =>
  `http://parse/v1/files/abc/parts/ppt/media/image1.png?exp=${exp}&sig=signature`

test('a loaded slide with expired image URLs refreshes its description before reuse', async () => {
  const originalWorker = globalThis.Worker
  const originalFetch = globalThis.fetch
  const ops: string[] = []
  let future = false
  const makeUnit = () => ({
    slide: {
      widthPx: 960,
      heightPx: 540,
      nodes: [{ type: 'image', src: signed(future ? 9_999_999_999 : 1) }],
    },
    playback: {},
    mediaRefs: [],
  })
  const WorkerStub = workerProbe((worker, message) => {
    ops.push(message.op)
    if (message.op === 'open' || message.op === 'unit')
      worker.reply(message.id, { unit: makeUnit(), measurements: [], fallbacks: [] })
    else if (message.op === 'refresh') {
      future = true
      worker.reply(message.id, {})
    } else if (message.op === 'release') worker.reply(message.id, { dropped: [] })
  })
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
