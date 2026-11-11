import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocxRemoteSession } from '../src/web/docx-remote-session.ts'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const part = (exp: number) =>
  `http://parse/v1/files/abc/parts/word/media/image1.png?exp=${exp}&sig=signature`

interface Stub {
  unitReads: number
  paths: string[]
}

function stubFetch(context: any, responses: Array<{ image: string }>): Stub {
  const state: Stub = { unitReads: 0, paths: [] }
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    state.paths.push(url)
    if (url.endsWith('/v2/sessions') && init.method === 'POST')
      return json({ sessionId: 's', state: 'ready', model: {}, fonts: [] }, 201)
    if (url.includes('/units/0')) {
      const next = responses[Math.min(state.unitReads, responses.length - 1)]
      state.unitReads += 1
      return json({ blocks: [{ type: 'paragraph', image: next.image }] })
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return json({ message: 'unexpected' }, 404)
  })
  return state
}

test('reloads a cached chunk whose signed resource URL expired', async (context) => {
  const state = stubFetch(context, [{ image: part(1) }, { image: part(9_999_999_999) }])
  const session = new DocxRemoteSession(
    { server: 'http://parse', fileId: 'abc', skipCapabilities: true },
    async () => {},
  )
  try {
    await session.open()
    const first = await session.unit('0')
    assert.match(String(first.blocks[0].image), /exp=1&/)
    const second = await session.unit('0')
    assert.match(String(second.blocks[0].image), /exp=9999999999/)
    assert.equal(state.unitReads, 2, 'expired cached description must be refreshed once')
  } finally {
    session.close()
  }
})

test('keeps a fresh signed chunk cached without refetching', async (context) => {
  const state = stubFetch(context, [{ image: part(9_999_999_999) }])
  const session = new DocxRemoteSession(
    { server: 'http://parse', fileId: 'abc', skipCapabilities: true },
    async () => {},
  )
  try {
    await session.open()
    await session.unit('0')
    await session.unit('0')
    assert.equal(state.unitReads, 1, 'fresh signatures stay cached')
  } finally {
    session.close()
  }
})
