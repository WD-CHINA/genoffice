import { json } from './helpers/session-probes.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DocxRemoteSession } from '../src/web/docx-remote-session.ts'

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
    if (url.endsWith('/v1/sessions') && init.method === 'POST')
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

for (const scenario of [
  { name: 'reloads a cached chunk whose signed resource URL expired', expiry: 1, reads: 2 },
  { name: 'keeps a fresh signed chunk cached without refetching', expiry: 9_999_999_999, reads: 1 },
])
  test(scenario.name, async (context) => {
    const state = stubFetch(context, [
      { image: part(scenario.expiry) },
      { image: part(9_999_999_999) },
    ])
    const session = new DocxRemoteSession(
      { server: 'http://parse', fileId: 'abc', skipCapabilities: true },
      async () => {},
    )
    try {
      await session.open()
      assert.match(
        String((await session.unit('0')).blocks[0].image),
        new RegExp(`exp=${scenario.expiry}&`),
      )
      assert.match(String((await session.unit('0')).blocks[0].image), /exp=9999999999/)
      assert.equal(state.unitReads, scenario.reads)
    } finally {
      session.close()
    }
  })
