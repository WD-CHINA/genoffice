import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLibraryClient } from '../src/web/server-library.ts'

test('history client preserves server/auth settings and rejects failed saves before returning an entry', async (context) => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  context.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    if (init.method === 'POST')
      return new Response(JSON.stringify({ message: 'storage full' }), { status: 507 })
    if (init.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ items: [], next: 'next-cursor' }))
  })
  const client = createLibraryClient('https://parse.example/base/', 'test-token')
  await assert.rejects(client.save('file', 'deck.pptx'), /storage full/)
  assert.equal(requests[0].url, 'https://parse.example/base/v1/library')
  assert.equal(new Headers(requests[0].init.headers).get('Authorization'), 'Bearer test-token')
  assert.deepEqual(JSON.parse(requests[0].init.body as string), {
    fileId: 'file',
    displayName: 'deck.pptx',
  })
  const controller = new AbortController()
  assert.deepEqual(await client.list('cursor with spaces', controller.signal), {
    items: [],
    next: 'next-cursor',
  })
  assert.equal(
    requests[1].url,
    'https://parse.example/base/v1/library?limit=50&cursor=cursor+with+spaces',
  )
  assert.equal(requests[1].init.signal, controller.signal)
  await client.remove('entry/id')
  assert.equal(requests[2].url, 'https://parse.example/base/v1/library/entry%2Fid')
})
