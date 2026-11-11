import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resetCapabilitiesCacheForTests } from '../src/web/capabilities.ts'
import {
  openServerSession, updateSessionLayoutPrefs, type PreviewNotice,
} from '../src/web/server-session.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => resetCapabilitiesCacheForTests())

test('an explicit asyncSessions=false capability forces the v1 contract', async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    paths.push(url)
    if (url.endsWith('/v2/capabilities'))
      return json({ features: { asyncSessions: false, incrementalPreview: false } })
    if (init.method === 'POST') {
      assert.ok(url.endsWith('/v1/sessions'), 'v1 must be used when v2 async is disabled')
      return json({ sessionId: 'legacy', model: { unitCount: 2 } }, 201)
    }
    return json({ sessionId: 'legacy', state: 'ready' })
  })
  const result = await openServerSession<{ sessionId: string }>({
    server: 'http://parse', fileId: 'file',
  })
  assert.equal(result.sessionId, 'legacy')
  assert.deepEqual(paths, ['http://parse/v2/capabilities', 'http://parse/v1/sessions'])
})

test('incrementalPreview=false suppresses preview states and preview notices', async (context) => {
  let polls = 0
  const states: string[] = []
  const previews: PreviewNotice[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/v2/capabilities'))
      return json({ features: { asyncSessions: true, incrementalPreview: false } })
    if (init.method === 'POST')
      return json({
        sessionId: 's', state: 'building', pollAfterMs: 1,
        previewable: true, progress: { unitsProduced: 1, unitCount: 2, percent: 50 },
      }, 202)
    return json(++polls === 1
      ? {
          sessionId: 's', state: 'building', pollAfterMs: 1,
          previewable: true, progress: { unitsProduced: 1, unitCount: 2, percent: 50 },
        }
      : { sessionId: 's', state: 'ready', model: { unitCount: 2 }, fonts: [] })
  })
  await openServerSession({
    server: 'http://parse', fileId: 'file',
    onState: (state) => states.push(state),
    onPreview: (preview) => previews.push(preview),
  })
  assert.deepEqual(states, ['building', 'building'])
  assert.equal(previews.length, 0)
})

test('a missing capabilities route keeps the current v2 behaviour', async (context) => {
  const paths: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    paths.push(url)
    if (url.endsWith('/v2/capabilities')) return json({ message: 'not found' }, 404)
    if (init.method === 'POST')
      return json({ sessionId: 'v2', state: 'ready', model: { unitCount: 1 }, fonts: [] })
    return json({ sessionId: 'v2', state: 'ready' })
  })
  const result = await openServerSession<{ sessionId: string }>({
    server: 'http://parse', fileId: 'file',
  })
  assert.equal(result.sessionId, 'v2')
  assert.deepEqual(paths, ['http://parse/v2/capabilities', 'http://parse/v2/sessions'])
})

test('a saved reading position is sent as layoutPrefs to the v2 contract', async (context) => {
  let posted: unknown
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/v2/capabilities')) return json({ features: { asyncSessions: true } })
    if (init.method === 'POST') {
      posted = JSON.parse(String(init.body))
      return json({ sessionId: 'v2', state: 'ready', model: { unitCount: 1 }, fonts: [] })
    }
    return json({ sessionId: 'v2', state: 'ready' })
  })
  await openServerSession({
    server: 'http://parse', fileId: 'file',
    layoutPrefs: { page: 4 },
  })
  assert.deepEqual(posted, { fileId: 'file', layoutPrefs: { page: 4 } })
})

test('incremental layoutPrefs are posted to the heartbeat route', async (context) => {
  let request: { url: string; body: unknown } | undefined
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    request = { url, body: JSON.parse(String(init.body)) }
    return json({ sessionId: 's', state: 'ready' })
  })
  await updateSessionLayoutPrefs('http://parse', 's', { page: 6 }, 'secret')
  assert.equal(request?.url, 'http://parse/v2/sessions/s/heartbeat')
  assert.deepEqual(request?.body, { layoutPrefs: { page: 6 } })
})
