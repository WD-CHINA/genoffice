import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModelSession, workerProbe } from './helpers/session-probes.ts'

const { createModelPptxSession } = await loadModelSession()

// Exercise the real session's RPC/lifecycle with controlled worker replies and HTTP.
test('125-minute idle presentation keeps its session alive; concurrent reads deduplicate', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const originalWorker = globalThis.Worker
  const originalFetch = globalThis.fetch
  const calls: string[] = []
  const messages: Array<{ id: number; op: string; input: any }> = []
  const unit = { slide: { widthPx: 960, heightPx: 540, nodes: [] }, playback: {}, mediaRefs: [] }
  const WorkerStub = workerProbe((worker, message) => {
    messages.push(message)
    if (message.op === 'open') worker.reply(message.id, { unit, measurements: [], fallbacks: [] })
    if (message.op === 'release') worker.reply(message.id, { dropped: message.input.indexes })
  })
  globalThis.Worker = WorkerStub as unknown as typeof Worker
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method || 'GET'} ${url}`)
    const body =
      init?.method === 'POST'
        ? { sessionId: 'test-session', fonts: [] }
        : url.endsWith('/layout')
          ? { slideCount: 20, fonts: [] }
          : { state: 'ready' }
    return new Response(JSON.stringify(body))
  }) as typeof fetch
  const session = createModelPptxSession({ server: 'http://parse', fileId: 'file' })
  try {
    await session.open(new ArrayBuffer(0))
    t.mock.timers.tick(125 * 60_000)
    assert.equal(
      calls.filter((call) => call === 'GET http://parse/v1/sessions/test-session').length,
      125,
    )
    const first = session.loadUnit(10)
    const second = session.loadUnit(10)
    const reads = messages.filter((message) => message.op === 'unit')
    assert.equal(reads.length, 1)
    // Eviction cannot drop a page that is still being loaded.
    await session.release([0])
    assert.equal(messages.filter((message) => message.op === 'release').length, 0)
    WorkerStub.current.reply(reads[0].id, { unit, measurements: [], fallbacks: [] })
    await Promise.all([first, second])
    assert.deepEqual(await session.release([0]), [10])
    const pending = session.loadUnit(15)
    const rejected = assert.rejects(pending, /Presentation closed/)
    session.close()
    await rejected
    const afterClose = calls.length
    t.mock.timers.tick(60 * 60_000)
    assert.equal(calls.length, afterClose)
    assert.equal(WorkerStub.current.terminated, true)
  } finally {
    session.close()
    globalThis.Worker = originalWorker
    globalThis.fetch = originalFetch
    t.mock.timers.reset()
  }
})
