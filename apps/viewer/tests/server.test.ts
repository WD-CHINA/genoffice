import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'

let server: Server, url: string, dir: string, cookie: string, other: string
const fixture = new URL(
  '../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
  import.meta.url,
)
const pdf = Buffer.from('%PDF-1.4\nViewer API range fixture\n%%EOF')
async function request(path: string, init: RequestInit = {}, owner = cookie) {
  return fetch(url + '/api/' + path, { ...init, headers: { Cookie: owner, ...init.headers } })
}
async function post(path: string, value: unknown, owner = cookie) {
  return request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    },
    owner,
  )
}
async function upload(name: string, data: Buffer) {
  const response = await request('files', {
    method: 'POST',
    headers: { 'X-File-Name': encodeURIComponent(name) },
    body: new Uint8Array(data),
  })
  assert.equal(response.status, 201)
  return response.json()
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'genoffice-viewer-test-'))
  process.env.VIEWER_DATA_DIR = dir
  process.env.VIEWER_MAX_UPLOAD_BYTES = String(1024 * 1024)
  const entry = new URL('../dist/server/index.mjs', import.meta.url).href
  const { createViewerServer } = await import(entry)
  server = await createViewerServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  url = `http://127.0.0.1:${address.port}`
  cookie = (await fetch(url + '/api/health')).headers.get('set-cookie')!.split(';')[0]
  other = (await fetch(url + '/api/health')).headers.get('set-cookie')!.split(';')[0]
})
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})
test('requires an initialized owner and accepts only this origin', async () => {
  assert.equal((await request('files', { method: 'POST' }, '')).status, 401)
  assert.equal(
    (await request('health', { headers: { Origin: 'http://127.0.0.1:9999' } })).status,
    403,
  )
  assert.equal((await request('health', { headers: { Origin: url } })).status, 200)
  assert.equal((await request('view-sessions', { method: 'POST', body: '{' })).status, 400)
})
test('rejects mismatched bytes and unsupported file types', async () => {
  for (const name of ['document.exe', 'document.docx', 'document.pptx']) {
    assert.equal(
      (
        await request('files', {
          method: 'POST',
          headers: { 'X-File-Name': name },
          body: new Uint8Array(pdf),
        })
      ).status,
      415,
    )
  }
})
test('enforces configured upload size', async () => {
  assert.equal(
    (
      await request('files', {
        method: 'POST',
        headers: { 'X-File-Name': 'large.pdf' },
        body: new Uint8Array(1024 * 1024 + 1),
      })
    ).status,
    413,
  )
})

test('isolates owners, streams byte ranges, and invalidates deleted sessions', async () => {
  const file = await upload('只读文档.pdf', pdf)
  assert.equal(file.hash, createHash('sha256').update(pdf).digest('hex'))
  assert.equal((await post('view-sessions', { fileId: file.id }, other)).status, 404)
  assert.equal((await post('view-sessions', { fileId: file.id, width: 0 })).status, 400)
  const response = await post('view-sessions', { fileId: file.id })
  assert.equal(response.status, 201)
  const session = await response.json(),
    path = `view-sessions/${session.id}`
  assert.equal((await request(path, {}, other)).status, 404)
  assert.equal((await request(path + '/slides')).status, 400)
  const part = await request(path + '/content', { headers: { Range: 'bytes=0-7' } })
  assert.equal(part.status, 206)
  assert.equal(part.headers.get('content-range'), `bytes 0-7/${pdf.length}`)
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), pdf.subarray(0, 8))
  const invalid = await request(path + '/content', { headers: { Range: 'bytes=9999-' } })
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), `bytes */${pdf.length}`)
  assert.deepEqual(await readFile(join(dir, file.id)), pdf)
  assert.equal((await request(path, { method: 'DELETE' })).status, 200)
  assert.equal((await request(path + '/content')).status, 404)
})
test('opens original PPT fixtures and serializes concurrent font feedback', async () => {
  const original = await readFile(fixture)
  const file = await upload('business.pptx', original)
  const response = await post('view-sessions', { fileId: file.id })
  assert.equal(response.status, 201)
  const session = await response.json(),
    path = `view-sessions/${session.id}`
  const data = await (await request(path + '/slides')).json()
  assert.equal(data.slides.length, 5)
  assert.equal(data.playback.length, 5)
  assert.ok(data.slides.every((slide: any) => slide.nodes.length > 0))
  assert.equal(
    (
      await post(path + '/text-widths', {
        revision: data.revision,
        batchId: data.batchId,
        widths: { unknown: 5 },
      })
    ).status,
    400,
  )
  const feedback = { revision: data.revision, batchId: data.batchId, widths: {} }
  const concurrent = await Promise.all([
    post(path + '/text-widths', feedback),
    post(path + '/text-widths', feedback),
  ])
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409])
  assert.equal((await post(path + '/text-widths', feedback)).status, 409)
  assert.deepEqual(await readFile(join(dir, file.id)), original)
  assert.equal((await request(path, { method: 'DELETE' })).status, 200)
  assert.equal((await request(path + '/fonts/invalid')).status, 404)
})
test('converts Word altChunk using the original Chromium converter', async () => {
  const data = await readFile(
    new URL('../../../fixtures/generated/kitchen-sink.docx', import.meta.url),
  )
  const file = await upload('kitchen-sink.docx', data)
  const session = await (await post('view-sessions', { fileId: file.id })).json()
  const path = `view-sessions/${session.id}`
  const result = await post(path + '/altchunks', {
    html: '<html><body><h1>Original converter</h1><p>Read only</p></body></html>',
  })
  assert.equal(result.status, 200, await result.clone().text())
  const converted = Buffer.from(await result.arrayBuffer())
  assert.equal(converted.subarray(0, 4).toString('hex'), '504b0304')
  assert.deepEqual(await readFile(join(dir, file.id)), data)
  await request(path, { method: 'DELETE' })
})
