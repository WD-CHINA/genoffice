import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { isPublicAddress } from '../src/server/url-import'

let viewer: Server, restricted: Server, origin: Server, base: string, restrictedBase: string, source: string, dir: string, cookie: string, restrictedCookie: string, other: string
let ppt: Buffer, word: Buffer
const pdf = Buffer.from('%PDF-1.4\nURL import fixture\n%%EOF')
const hits: string[] = []
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
async function post(path: string, value: unknown, owner = cookie, target = base, signal?: AbortSignal) {
  return fetch(target + '/api/' + path, { method: 'POST', headers: { Cookie: owner, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal })
}
async function imported(path: string) {
  const response = await post('files/import-url', { url: source + path })
  assert.equal(response.status, 201, await response.clone().text())
  return response.json()
}
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'viewer-url-api-'))
  process.env.VIEWER_DATA_DIR = dir
  process.env.VIEWER_MAX_UPLOAD_BYTES = String(1024 * 1024)
  ppt = await readFile(new URL('../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx', import.meta.url))
  word = await readFile(new URL('../../../fixtures/generated/simple.docx', import.meta.url))
  origin = createServer((req, res) => {
    hits.push(req.url || '')
    const url = new URL(req.url || '/', 'http://source')
    if (url.pathname === '/redirect') { res.writeHead(302, { Location: '/download?signature=kept' }); return res.end() }
    if (url.pathname === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end() }
    if (url.pathname === '/unsafe-redirect') { res.writeHead(302, { Location: 'file:///etc/passwd' }); return res.end() }
    if (url.pathname === '/redirect-private') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); return res.end() }
    if (url.pathname === '/download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': "attachment; filename=ignored.pdf; filename*=UTF-8''%E8%BF%9C%E7%A8%8B%E6%96%87%E6%A1%A3.pdf" }); return res.end(pdf)
    }
    if (url.pathname === '/slides.pptx') return res.end(ppt)
    if (url.pathname === '/word') return res.end(word)
    if (url.pathname === '/gzip.pdf') { res.setHeader('Content-Encoding', 'gzip'); return res.end(gzipSync(pdf)) }
    if (url.pathname === '/html.pdf') { res.setHeader('Content-Type', 'text/html'); return res.end('<html>Sign in to download</html>') }
    if (url.pathname === '/wrong.docx') return res.end(pdf)
    if (url.pathname === '/empty.pdf') return res.end()
    if (url.pathname === '/large.pdf') { res.setHeader('Content-Length', 1024 * 1024 + 1); return res.end() }
    if (url.pathname === '/large-chunked.pdf') { res.writeHead(200); res.write(Buffer.alloc(600_000)); return res.end(Buffer.alloc(600_000)) }
    if (url.pathname === '/compressed-large.pdf') { res.setHeader('Content-Encoding', 'gzip'); return res.end(gzipSync(Buffer.alloc(1024 * 1024 + 1))) }
    if (url.pathname === '/slow.pdf') {
      res.writeHead(200); res.write(pdf)
      const timer = setTimeout(() => res.end(pdf), 3000)
      res.on('close', () => clearTimeout(timer)); return
    }
    res.writeHead(404); res.end('Missing')
  })
  source = await listen(origin)
  const { createViewerServer } = await import('../dist/server/index.mjs')
  viewer = await createViewerServer({ urlImport: { allowPrivateNetwork: true, timeoutMs: 400 } })
  restricted = await createViewerServer()
  base = await listen(viewer); restrictedBase = await listen(restricted)
  cookie = (await fetch(base + '/api/health')).headers.get('set-cookie')!.split(';')[0]
  other = (await fetch(base + '/api/health')).headers.get('set-cookie')!.split(';')[0]
  restrictedCookie = (await fetch(restrictedBase + '/api/health')).headers.get('set-cookie')!.split(';')[0]
})
after(async () => {
  for (const server of [viewer, restricted, origin]) await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
})
test('imports signed redirected URLs, preserves bytes/name, and keeps owner isolation', async () => {
  const file = await imported('/redirect')
  assert.equal(file.name, '远程文档.pdf'); assert.equal(file.format, 'pdf')
  assert.equal(file.hash, createHash('sha256').update(pdf).digest('hex'))
  assert.ok(hits.includes('/download?signature=kept'))
  assert.deepEqual(await readFile(join(dir, file.id)), pdf)
  assert.equal((await post('view-sessions', { fileId: file.id }, other)).status, 404)
  const response = await post('view-sessions', { fileId: file.id }); assert.equal(response.status, 201)
  const session = await response.json()
  const content = await fetch(`${base}/api/view-sessions/${session.id}/content`, { headers: { Cookie: cookie, Range: 'bytes=0-7' } })
  assert.equal(content.status, 206); assert.deepEqual(Buffer.from(await content.arrayBuffer()), pdf.subarray(0, 8))
  await fetch(`${base}/api/view-sessions/${session.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
})
test('detects Office format from ZIP contents and uses the existing PPT worker', async () => {
  const docx = await imported('/word'); assert.equal(docx.name, 'word.docx'); assert.equal(docx.format, 'docx')
  assert.deepEqual(await readFile(join(dir, docx.id)), word)
  const deck = await imported('/slides.pptx'); assert.equal(deck.format, 'pptx')
  const session = await (await post('view-sessions', { fileId: deck.id })).json()
  const data = await (await fetch(`${base}/api/view-sessions/${session.id}/slides`, { headers: { Cookie: cookie } })).json()
  assert.equal(data.slides.length, 5)
  await fetch(`${base}/api/view-sessions/${session.id}`, { method: 'DELETE', headers: { Cookie: cookie } })
})
test('decodes HTTP gzip while hashing the original document bytes', async () => {
  const file = await imported('/gzip.pdf'); assert.deepEqual(await readFile(join(dir, file.id)), pdf)
})
test('rejects invalid schemes, embedded credentials and unavailable files', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/a.pdf', 'http://user:password@example.com/a.pdf', 'javascript:alert(1)', 'not a URL']) {
    assert.equal((await post('files/import-url', { url })).status, 400)
  }
  assert.equal((await post('files/import-url', { url: source + '/download' }, '')).status, 401)
  for (const [path, status] of [['/missing.pdf', 502], ['/html.pdf', 415], ['/wrong.docx', 415], ['/empty.pdf', 400], ['/loop', 502], ['/unsafe-redirect', 400]] as const) {
    const before = await readdir(dir)
    assert.equal((await post('files/import-url', { url: source + path })).status, status, path)
    assert.deepEqual(await readdir(dir), before, 'Failed imports leave no partial files')
  }
})
test('enforces declared, streamed and decompressed size limits and total timeout', async () => {
  for (const [path, status] of [['/large.pdf', 413], ['/large-chunked.pdf', 413], ['/compressed-large.pdf', 413], ['/slow.pdf', 504]] as const) {
    const before = await readdir(dir)
    assert.equal((await post('files/import-url', { url: source + path })).status, status, path)
    assert.deepEqual(await readdir(dir), before)
  }
})
test('cancels an import when its client disconnects', async () => {
  const before = await readdir(dir), controller = new AbortController()
  const request = post('files/import-url', { url: source + '/slow.pdf' }, cookie, base, controller.signal).catch(() => undefined)
  await delay(50); controller.abort(); await request
  await delay(100)
  assert.deepEqual(await readdir(dir), before)
  assert.equal((await post('files/import-url', { url: source + '/gzip.pdf' })).status, 201)
})
test('blocks local, private and reserved destinations by default before making requests', async () => {
  const before = hits.length
  for (const url of [source + '/download', 'http://localhost/a.pdf', 'http://2130706433/a.pdf', 'http://[::1]/a.pdf', 'http://[::ffff:127.0.0.1]/a.pdf', 'http://169.254.169.254/latest/meta-data'])
    assert.equal((await post('files/import-url', { url }, restrictedCookie, restrictedBase)).status, 403, url)
  assert.equal(hits.length, before)
  for (const ip of ['127.0.0.1', '10.1.1.1', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.169.254', '192.0.2.1', '198.18.1.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(ip), false, ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '192.0.8.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip)
})
