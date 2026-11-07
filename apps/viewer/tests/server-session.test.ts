import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openServerSession } from '../src/web/server-session.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

test('async opening follows queued/building/ready with one creation and preserves credentials', async (context) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const states: string[] = []
  const controller = new AbortController()
  let polls = 0
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    if (init.method === 'POST')
      return json({ sessionId: 'one', state: 'queued', pollAfterMs: 1 }, 202)
    return json(
      ++polls === 1
        ? { sessionId: 'one', state: 'building', pollAfterMs: 1 }
        : { sessionId: 'one', state: 'ready', model: { unitCount: 10 }, fonts: [] },
    )
  })
  const result = await openServerSession<{ sessionId: string; model: { unitCount: number } }>({
    server: 'http://parse/',
    fileId: 'file',
    token: 'secret',
    width: 1200,
    signal: controller.signal,
    onState: (state) => states.push(state),
  })
  assert.deepEqual(states, ['queued', 'building'])
  assert.equal(result.model.unitCount, 10)
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://parse/v2/sessions', 'http://parse/v2/sessions/one', 'http://parse/v2/sessions/one'],
  )
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer secret')
    assert.equal(call.init.signal, controller.signal)
  }
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { fileId: 'file', width: 1200 })
})

test('older and offline servers fall back to v1 only when v2 is unsupported', async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    paths.push(url)
    return url.endsWith('/v2/sessions')
      ? json({ message: 'not found' }, 404)
      : json({ sessionId: 'offline', model: { unitCount: 1 } }, 201)
  })
  const result = await openServerSession({ server: 'http://local', fileId: 'file' })
  assert.equal(result.sessionId, 'offline')
  assert.deepEqual(paths, ['http://local/v2/sessions', 'http://local/v1/sessions'])
})

test('queue saturation does not retry through v1 and bypass admission', async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    paths.push(url)
    return json({ message: 'queue full' }, 429)
  })
  await assert.rejects(openServerSession({ server: 'http://parse', fileId: 'file' }), /queue full/)
  assert.deepEqual(paths, ['http://parse/v2/sessions'])
})

test('cancelling during a polling delay deletes only this waiter using a fresh request', async (context) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const controller = new AbortController()
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return init.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : json({ sessionId: 'cancelled', state: 'queued', pollAfterMs: 1000 }, 202)
  })
  await assert.rejects(
    openServerSession({
      server: 'http://parse',
      fileId: 'file',
      signal: controller.signal,
      onState: () => controller.abort(),
    }),
    { name: 'AbortError' },
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'http://parse/v2/sessions/cancelled')
  assert.equal(calls[1].init.method, 'DELETE')
  assert.equal(calls[1].init.signal, undefined)
})

test('failed jobs report their error, clean up the waiter, and never poll forever', async (context) => {
  const calls: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${url}`)
    if (init.method === 'POST')
      return json({ sessionId: 'failed', state: 'building', pollAfterMs: 1 }, 202)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return json({
      sessionId: 'failed',
      state: 'failed',
      error: { code: 'parse_memory_limit', message: 'memory limit' },
    })
  })
  await assert.rejects(
    openServerSession({ server: 'http://parse', fileId: 'file' }),
    /memory limit/,
  )
  assert.deepEqual(calls, [
    'POST http://parse/v2/sessions',
    'GET http://parse/v2/sessions/failed',
    'DELETE http://parse/v2/sessions/failed',
  ])
})

test('closing a remote deck at the ready boundary does not resurrect heartbeat timers or load a slide', async (context) => {
  const { createRemotePptxSession } = await import('../src/web/pptx-remote-session.ts')
  context.mock.timers.enable({ apis: ['setInterval'] })
  const calls: string[] = []
  let session: ReturnType<typeof createRemotePptxSession>
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push(`${init.method ?? 'GET'} ${url}`)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    const body = {
      sessionId: 'ready-boundary',
      model: { unitCount: 1 },
      get state() {
        queueMicrotask(() => session.close())
        return 'ready'
      },
    }
    const response = json({})
    response.json = async () => body
    return response
  })
  session = createRemotePptxSession({ server: 'http://parse', fileId: 'file' })
  try {
    await assert.rejects(session.open(new ArrayBuffer(0)), /Presentation closed/)
    assert.deepEqual(calls, [
      'POST http://parse/v2/sessions',
      'DELETE http://parse/v1/sessions/ready-boundary',
    ])
    context.mock.timers.tick(60 * 60_000)
    assert.equal(calls.length, 2)
  } finally {
    session.close()
    context.mock.timers.reset()
  }
})
