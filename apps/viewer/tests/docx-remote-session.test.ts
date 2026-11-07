import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocxRemoteSession } from '../src/web/docx-remote-session.ts'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

test('expired unit reopens once and resumes the same cursor without duplicating committed chunks', async (context) => {
  let creations = 0
  let expired = false
  const paths: string[] = []
  const metadata: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    paths.push(url)
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer secret')
    if (init.method === 'POST') return json({ sessionId: `s${++creations}`, state: 'ready' }, 201)
    if (url.includes('units?'))
      return json(
        url.includes('cursor=next')
          ? { items: [{ id: '1' }] }
          : { items: [{ id: '0' }], next: 'next' },
      )
    if (url.endsWith('/s1/units/1')) {
      expired = true
      return json({}, 404)
    }
    return json({ blocks: [{ text: url.endsWith('/units/0') ? 'first' : 'second' }] })
  })
  const session = new DocxRemoteSession(
    { server: 'http://parse', fileId: 'file', token: 'secret' },
    async (opened) => {
      metadata.push(opened.sessionId)
    },
  )
  try {
    const first = await session.load()
    assert.deepEqual(first.blocks, [{ text: 'first' }])
    const second = await session.load(first.next)
    assert.equal(expired, true)
    assert.deepEqual(second.blocks, [{ text: 'second' }])
    assert.equal(second.hasMore, false)
    assert.deepEqual(metadata, ['s1', 's2'])
    assert.equal(paths.filter((url) => url.includes('cursor=next')).length, 2)
    assert.deepEqual((await session.load()).blocks, [])
    assert.equal(creations, 2)
  } finally {
    session.close()
  }
})

test('failed chunk batch leaves cursor retryable and concurrent reads share one request', async (context) => {
  let fail = true
  let listings = 0
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ sessionId: 's', state: 'ready' }, 201)
    if (url.includes('units?')) {
      listings++
      return json({ items: [{ id: '0' }, { id: '1' }], next: 'two' })
    }
    if (url.endsWith('/1') && fail) return json({}, 500)
    return json({ blocks: [url.endsWith('/0') ? 'a' : 'b'] })
  })
  const session = new DocxRemoteSession({ server: 'http://parse', fileId: 'file' }, async () => {})
  try {
    const a = session.load()
    assert.equal(a, session.load())
    await assert.rejects(a, /HTTP 500/)
    fail = false
    assert.deepEqual(await session.load(), { blocks: ['a', 'b'], units: [{ id: '0', blocks: ['a'] }, { id: '1', blocks: ['b'] }], next: 'two', hasMore: true })
    assert.equal(listings, 2)
  } finally {
    session.close()
  }
})

test('close fences a late response even when fetch ignores cancellation', async (context) => {
  let release!: () => void
  let arrived!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const observed = new Promise<void>((resolve) => {
    arrived = resolve
  })
  const deleted: string[] = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') {
      deleted.push(url)
      return new Response(null, { status: 204 })
    }
    if (init.method === 'POST') return json({ sessionId: 'old', state: 'ready' }, 201)
    arrived()
    await blocked
    return json({ items: [{ id: '0' }] })
  })
  const session = new DocxRemoteSession(
    { server: 'http://parse', fileId: 'old-file' },
    async () => {},
  )
  const pending = session.load()
  await observed
  session.close()
  release()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(deleted, ['http://parse/v1/sessions/old'])
})

test('repeated expiry is bounded to one recovery rather than looping indefinitely', async (context) => {
  let creations = 0
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ sessionId: `s${++creations}`, state: 'ready' }, 201)
    return json({}, 410)
  })
  const session = new DocxRemoteSession({ server: 'http://parse', fileId: 'file' }, async () => {})
  try {
    await assert.rejects(session.load())
    assert.equal(creations, 2)
  } finally {
    session.close()
  }
})

test('random access shares pending reads and refreshes cached URLs after session recovery', async (context) => {
  let creations = 0
  let reads = 0
  let expire = false
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ sessionId: `s${++creations}`, state: 'ready' }, 201)
    reads++
    if (url.endsWith('/units/other') && expire && url.includes('/s1/')) return json({}, 410)
    return json({ blocks: [{ url }] })
  })
  const session = new DocxRemoteSession({ server: 'http://parse', fileId: 'file' }, async () => {})
  try {
    const first = session.unit('first')
    assert.equal(first, session.unit('first'))
    assert.match((await first).blocks[0].url, /\/s1\//)
    await session.unit('first')
    assert.equal(reads, 1)
    expire = true
    assert.match((await session.unit('other')).blocks[0].url, /\/s2\//)
    assert.match((await session.unit('first')).blocks[0].url, /\/s2\//)
    assert.equal(creations, 2)
    assert.equal(reads, 4)
  } finally {
    session.close()
  }
})

test('random access retries failures, bounds repeated expiry and fences late reads on close', async (context) => {
  let mode = 'bad'
  let creations = 0
  let release!: () => void
  let arrived!: () => void
  const observed = new Promise<void>((resolve) => { arrived = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ sessionId: `s${++creations}`, state: 'ready' }, 201)
    if (mode === 'bad') return json({ blocks: null })
    if (mode === 'expire') return json({}, 410)
    arrived()
    await gate
    return json({ blocks: ['late'] })
  })
  const session = new DocxRemoteSession({ server: 'http://parse', fileId: 'file' }, async () => {})
  try {
    await assert.rejects(session.unit('x'), /格式无效/)
    mode = 'expire'
    await assert.rejects(session.unit('x'), /失效/)
    assert.equal(creations, 2)
    mode = 'late'
    const pending = session.unit('x')
    await observed
    session.close()
    release()
    await assert.rejects(pending, { name: 'AbortError' })
  } finally {
    release()
    session.close()
  }
})

test('failed layout preparation leaves units uncommitted and cursor retryable', async (context) => {
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ sessionId: 's', state: 'ready' }, 201)
    if (url.includes('units?')) return json({ items: [{ id: '0' }], next: 'one' })
    return json({ blocks: [{ docxIndex: 0, text: 'keep' }] })
  })
  const session = new DocxRemoteSession({ server: 'http://parse', fileId: 'file' }, async () => {})
  try {
    await assert.rejects(session.load(undefined, async () => { throw new Error('layout failed') }), /layout failed/)
    let prepared = 0
    const chunk = await session.load(undefined, async (units) => {
      prepared = units[0].blocks.length
    })
    assert.equal(prepared, 1)
    assert.equal(chunk.blocks.length, 1)
    assert.equal(chunk.units[0].id, '0')
  } finally {
    session.close()
  }
})

test('leaving a window cancels obsolete reads and their late bodies cannot overwrite fresh chunks', async (context) => {
  let release!: () => void
  let arrived!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const observed = new Promise<void>((resolve) => { arrived = resolve })
  let reads = 0
  let oldSignal: AbortSignal | undefined
  context.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    if (init.method === 'POST') return json({ sessionId: 's', state: 'ready' }, 201)
    if (++reads === 1) {
      oldSignal = init.signal as AbortSignal
      arrived()
      await gate
      return json({ blocks: ['obsolete'] })
    }
    return json({ blocks: ['fresh'] })
  })
  const session = new DocxRemoteSession({ server: 'http://parse', fileId: 'file' }, async () => {})
  try {
    const old = session.unit('0')
    const rejected = assert.rejects(old, { name: 'AbortError' })
    await observed
    session.retainUnits([])
    assert.equal(oldSignal?.aborted, true)
    assert.deepEqual((await session.unit('0')).blocks, ['fresh'])
    release()
    await rejected
    assert.deepEqual((await session.unit('0')).blocks, ['fresh'])
    assert.equal(reads, 2)
  } finally {
    release()
    session.close()
  }
})
