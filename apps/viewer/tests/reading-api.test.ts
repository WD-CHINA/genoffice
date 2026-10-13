import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import JSZip from 'jszip'

test('renews active sessions and removes idle sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewer-ttl-'))
  process.env.VIEWER_DATA_DIR = dir
  const { createViewerServer } = await import('../dist/server/index.mjs')
  const server = await createViewerServer({ sessionTtlMs: 300 })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  const url = `http://127.0.0.1:${address.port}/api/`
  const cookie = (await fetch(url + 'health')).headers.get('set-cookie')!.split(';')[0]
  const request = (path: string, init: RequestInit = {}) =>
    fetch(url + path, { ...init, headers: { Cookie: cookie, ...init.headers } })
  try {
    const file = await (
      await request('files', {
        method: 'POST',
        headers: { 'X-File-Name': 'test.pdf' },
        body: '%PDF-1.4\n%%EOF',
      })
    ).json()
    const session = await (
      await request('view-sessions', { method: 'POST', body: JSON.stringify({ fileId: file.id }) })
    ).json()
    for (let i = 0; i < 10; i++) {
      await delay(100)
      const response = await request(`view-sessions/${session.id}`)
      assert.equal(response.status, 200)
      assert.equal((await response.json()).heartbeatMs, 100)
    }
    await delay(650)
    assert.equal((await request(`view-sessions/${session.id}/content`)).status, 404)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
  }
})

test('serves original lazy media through session authorization, without modifying uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'viewer-lazy-'))
  // The bundled module already captured the temp root in this test process.
  const { createViewerServer } = await import('../dist/server/index.mjs')
  const server = await createViewerServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`
  const cookie = (await fetch(url + 'health')).headers.get('set-cookie')!.split(';')[0]
  const other = (await fetch(url + 'health')).headers.get('set-cookie')!.split(';')[0]
  const request = (path: string, init: RequestInit = {}, owner = cookie) =>
    fetch(url + path, { ...init, headers: { Cookie: owner, ...init.headers } })
  try {
    const zip = await JSZip.loadAsync(
      await readFile(new URL('../../../fixtures/generated/kitchen-sink.docx', import.meta.url)),
    )
    const part = Object.keys(zip.files).find((n) => /^word\/media\/.*\.png$/.test(n))!
    assert.ok(part)
    const image = Buffer.concat([
      await zip.file(part)!.async('nodebuffer'),
      Buffer.alloc(2 * 1024 * 1024),
    ])
    zip.file(part, image)
    const original = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
    const file = await (
      await request('files', {
        method: 'POST',
        headers: { 'X-File-Name': 'lazy.docx' },
        body: new Uint8Array(original),
      })
    ).json()
    const session = await (
      await request('view-sessions', { method: 'POST', body: JSON.stringify({ fileId: file.id }) })
    ).json()
    const base = `view-sessions/${session.id}`
    const content = Buffer.from(await (await request(base + '/content')).arrayBuffer())
    assert.ok(content.length < original.length)
    const slim = await JSZip.loadAsync(content)
    assert.ok((await slim.file(part)!.async('string')).startsWith('GENOFFICE-LAZY-MEDIA\n'))
    const hash = createHash('sha256').update(original).digest('hex')
    const media = `${base}/doc-media/${hash}?part=${encodeURIComponent(part)}`
    assert.equal((await request(media, {}, other)).status, 404)
    assert.equal(
      (await request(`${base}/doc-media/${'0'.repeat(64)}?part=${encodeURIComponent(part)}`))
        .status,
      404,
    )
    assert.equal((await request(`${base}/doc-media/${hash}?part=word/document.xml`)).status, 404)
    const response = await request(media)
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image)
    const ranged = await request(media, { headers: { Range: 'bytes=0-7' } })
    assert.equal(ranged.status, 206)
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), image.subarray(0, 8))
    // Repeated content reads reuse the prepared ZIP instead of losing its handles.
    assert.deepEqual(Buffer.from(await (await request(base + '/content')).arrayBuffer()), content)
    assert.deepEqual(await readFile(join(process.env.VIEWER_DATA_DIR!, file.id)), original)
    await request(base, { method: 'DELETE' })
    assert.equal((await request(media)).status, 404)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
    await rm(dir, { recursive: true, force: true })
    await rm(process.env.VIEWER_DATA_DIR!, { recursive: true, force: true })
  }
})
