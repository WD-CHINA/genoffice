import assert from 'node:assert/strict'
import { test } from 'node:test'
import { refreshSignedPartUrl } from '../src/web/part-url.ts'

const fileId = 'a'.repeat(64)
const oldUrl = `http://parse/v1/files/${fileId}/parts/ppt/media/image1.png?exp=1&sig=old`

test('refreshes a signed part URL through the authenticated endpoint', async () => {
  let seen: { url: string; body: unknown; auth: string | null } | undefined
  const fetchImpl = (async (input: string, init: RequestInit) => {
    seen = {
      url: input,
      body: JSON.parse(String(init.body)),
      auth: new Headers(init.headers).get('authorization'),
    }
    return new Response(JSON.stringify({ url: 'http://parse/fresh?sig=new' }), { status: 200 })
  }) as typeof fetch
  assert.equal(
    await refreshSignedPartUrl(oldUrl, { server: 'http://parse/', token: 'secret', fetchImpl }),
    'http://parse/fresh?sig=new',
  )
  assert.equal(seen?.url, `http://parse/v1/files/${fileId}/part-url`)
  assert.deepEqual(seen?.body, { path: 'ppt/media/image1.png' })
  assert.equal(seen?.auth, 'Bearer secret')
})

test('returns null for non-part URLs, failed refresh and malformed paths', async () => {
  const fetchImpl = (async () => new Response('{}', { status: 403 })) as typeof fetch
  assert.equal(await refreshSignedPartUrl('http://parse/v1/files/x/content', { server: 'http://parse', fetchImpl }), null)
  assert.equal(await refreshSignedPartUrl(oldUrl, { server: 'http://parse', fetchImpl }), null)
  const malformed = 'http://parse/v1/files/' + fileId + '/parts/bad%ZZ'
  assert.equal(await refreshSignedPartUrl(malformed, { server: 'http://parse', fetchImpl }), null)
})
