import { json } from './helpers/session-probes.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  openServerSession,
  openingStateText,
  type PreviewNotice,
} from '../src/web/server-session.ts'

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
    skipCapabilities: true,
    onState: (state) => states.push(state),
  })
  assert.deepEqual(states, ['queued', 'building'])
  assert.equal(result.model.unitCount, 10)
  assert.deepEqual(
    calls.map((call) => call.url),
    ['http://parse/v1/sessions', 'http://parse/v1/sessions/one', 'http://parse/v1/sessions/one'],
  )
  for (const call of calls) {
    assert.equal(new Headers(call.init.headers).get('Authorization'), 'Bearer secret')
    assert.equal(call.init.signal, controller.signal)
  }
  assert.equal(new Headers(calls[0].init.headers).get('Prefer'), 'respond-async')
  assert.equal(new Headers(calls[1].init.headers).get('Prefer'), null)
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { fileId: 'file', width: 1200 })
})

test('older and offline servers retry synchronously only when async mode is unsupported', async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    paths.push(url)
    return new Headers(init.headers).get('Prefer') === 'respond-async'
      ? json({ message: 'not found' }, 404)
      : json({ sessionId: 'offline', model: { unitCount: 1 } }, 201)
  })
  const result = await openServerSession({
    server: 'http://local',
    fileId: 'file',
    skipCapabilities: true,
  })
  assert.equal(result.sessionId, 'offline')
  assert.deepEqual(paths, ['http://local/v1/sessions', 'http://local/v1/sessions'])
})

test('queue saturation does not retry synchronously and bypass admission', async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    paths.push(url)
    return json({ message: 'queue full' }, 429)
  })
  await assert.rejects(
    openServerSession({ server: 'http://parse', fileId: 'file', skipCapabilities: true }),
    /queue full/,
  )
  assert.deepEqual(paths, ['http://parse/v1/sessions'])
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
      skipCapabilities: true,
      onState: () => controller.abort(),
    }),
    { name: 'AbortError' },
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'http://parse/v1/sessions/cancelled')
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
    openServerSession({ server: 'http://parse', fileId: 'file', skipCapabilities: true }),
    /memory limit/,
  )
  assert.deepEqual(calls, [
    'POST http://parse/v1/sessions',
    'GET http://parse/v1/sessions/failed',
    'DELETE http://parse/v1/sessions/failed',
  ])
})

test('closing a remote deck at the ready boundary does not resurrect heartbeat timers or load a slide', async (context) => {
  const { createRemotePptxSession } = await import('../src/web/pptx-remote-session.ts')
  context.mock.timers.enable({ apis: ['setInterval'] })
  const calls: string[] = []
  const session = createRemotePptxSession({ server: 'http://parse', fileId: 'file' })
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
  try {
    await assert.rejects(session.open(new ArrayBuffer(0)), /Presentation closed/)
    assert.deepEqual(calls, [
      'GET http://parse/v1/capabilities',
      'POST http://parse/v1/sessions',
      'DELETE http://parse/v1/sessions/ready-boundary',
    ])
    context.mock.timers.tick(60 * 60_000)
    assert.equal(calls.length, 3)
  } finally {
    session.close()
    context.mock.timers.reset()
  }
})

test('previewable is a building capability, notified once, and never ends the wait early', async (context) => {
  const states: string[] = []
  const notices: PreviewNotice[] = []
  let polls = 0
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (init.method === 'POST')
      return json(
        {
          sessionId: 'preview',
          state: 'building',
          previewable: true,
          pollAfterMs: 1,
          progress: { unitsProduced: 1, unitCount: 3, percent: 33 },
          availableUnits: { from: 0, to: 1 },
        },
        202,
      )
    return json(
      ++polls === 1
        ? {
            sessionId: 'preview',
            state: 'building',
            previewable: true,
            pollAfterMs: 1,
            progress: { unitsProduced: 2, unitCount: 3, percent: 66 },
            availableUnits: { from: 0, to: 2 },
          }
        : { sessionId: 'preview', state: 'ready', model: { unitCount: 3 }, fonts: [] },
    )
  })
  const result = await openServerSession<{
    sessionId: string
    state?: string
    model: { unitCount: number }
  }>({
    server: 'http://parse',
    fileId: 'file',
    onState: (state) => states.push(state),
    onPreview: (notice) => notices.push(notice),
  })
  assert.deepEqual(states, ['previewable', 'previewable'])
  assert.equal(notices.length, 1)
  assert.deepEqual(notices[0], {
    sessionId: 'preview',
    endpoint: '/v1/sessions',
    unitsProduced: 1,
    unitCount: 3,
    availableUnits: { from: 0, to: 1 },
  })
  assert.equal(result.state, 'ready')
  assert.equal(result.model.unitCount, 3)
  assert.match(openingStateText('previewable'), /首屏/)
  assert.match(openingStateText('queued'), /排队/)
})

const firstUnit = {
  slide: { widthPx: 960, heightPx: 540, nodes: [], background: { kind: 'solid', color: '#fff' } },
  playback: { transition: 'none', animations: [], keys: [], links: [], runLinks: [] },
  measurements: [],
}

test('remote sessions fetch and expose the committed first frame while still building', async (context) => {
  const { createRemotePptxSession } = await import('../src/web/pptx-remote-session.ts')
  context.mock.timers.enable({ apis: ['setInterval'] })
  const frames: Array<{ deck: any; complete: boolean; unitCount: number }> = []
  const urls: string[] = []
  let polls = 0
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(`${init.method ?? 'GET'} ${url}`)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST')
      return json(
        {
          sessionId: 'frame',
          state: 'building',
          previewable: true,
          pollAfterMs: 1,
          progress: { unitsProduced: 1, unitCount: 3, percent: 33 },
          availableUnits: { from: 0, to: 1 },
        },
        202,
      )
    if (url.endsWith('/document'))
      return json({
        state: 'building',
        model: { unitCount: 3 },
        fonts: [],
        layout: {},
        complete: false,
        unitsProduced: 1,
        unitCount: 3,
      })
    if (url.endsWith('/units/0')) return json(firstUnit)
    if (url.endsWith('/v1/sessions/frame'))
      return json(
        ++polls === 1
          ? {
              sessionId: 'frame',
              state: 'building',
              previewable: true,
              pollAfterMs: 1,
              progress: { unitsProduced: 1, unitCount: 3, percent: 33 },
              availableUnits: { from: 0, to: 1 },
            }
          : { sessionId: 'frame', state: 'ready', model: { unitCount: 3 }, fonts: [] },
      )
    return json(firstUnit)
  })
  const session = createRemotePptxSession({
    server: 'http://parse',
    fileId: 'file',
    onPreviewFrame: (frame) => frames.push(frame),
  })
  try {
    const deck = await session.open(new ArrayBuffer(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(deck.slides.length, 3, 'the ready deck remains the complete one')
    assert.equal(frames.length, 1)
    assert.equal(frames[0].complete, false)
    assert.equal(frames[0].unitCount, 3)
    assert.equal(frames[0].deck.preview, true)
    assert.equal(frames[0].deck.slides.length, 3)
    assert.equal(
      frames[0].deck.slides[1].placeholder,
      undefined,
      'uncommitted pages must not trigger lazy unit requests',
    )
    assert.ok(urls.includes('GET http://parse/v1/sessions/frame/document'))
    assert.ok(urls.includes('GET http://parse/v1/sessions/frame/units/0'))
    assert.ok(
      urls.includes('GET http://parse/v1/sessions/frame/units/0'),
      'the ready path keeps its original v1 contract',
    )
  } finally {
    session.close()
    context.mock.timers.reset()
  }
})

test('a failed first-frame prefetch never fails the authoritative ready path', async (context) => {
  const { createRemotePptxSession } = await import('../src/web/pptx-remote-session.ts')
  context.mock.timers.enable({ apis: ['setInterval'] })
  const frames: unknown[] = []
  let polls = 0
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST')
      return json(
        {
          sessionId: 'fragile',
          state: 'building',
          previewable: true,
          pollAfterMs: 1,
          progress: { unitsProduced: 1, unitCount: 1, percent: 99 },
          availableUnits: { from: 0, to: 1 },
        },
        202,
      )
    if (url.endsWith('/document')) return json({ message: 'preview unavailable' }, 503)
    if (url.endsWith('/v1/sessions/fragile'))
      return json(
        ++polls === 1
          ? {
              sessionId: 'fragile',
              state: 'building',
              previewable: true,
              pollAfterMs: 1,
              progress: { unitsProduced: 1, unitCount: 1, percent: 99 },
              availableUnits: { from: 0, to: 1 },
            }
          : { sessionId: 'fragile', state: 'ready', model: { unitCount: 1 }, fonts: [] },
      )
    return json(firstUnit)
  })
  const session = createRemotePptxSession({
    server: 'http://parse',
    fileId: 'file',
    onPreviewFrame: (frame) => frames.push(frame),
  })
  try {
    const deck = await session.open(new ArrayBuffer(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(deck.slides.length, 1)
    assert.equal(frames.length, 0)
  } finally {
    session.close()
    context.mock.timers.reset()
  }
})
