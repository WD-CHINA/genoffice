import assert from 'node:assert/strict'
import { test } from 'node:test'
import JSZip from 'jszip'
import { prepareRemoteMedia } from '../src/web/media-preparation'
import { resetCapabilitiesCacheForTests } from '../src/web/capabilities'
import { pptxHasMedia } from '../src/web/pptx-media-policy'

const fileId = 'a'.repeat(64), jobId = 'b'.repeat(64)
const media = { kind: 'video' as const, dataUrl: `https://parse.test/v1/files/${fileId}/parts/ppt/media/a.wmv?exp=1&sig=old` }
test('prepares original media and reports queued/converting states before using the signed output', async () => {
  resetCapabilitiesCacheForTests()
  const requests: Array<{ url: string; init?: RequestInit }> = [], statuses: string[] = []
  let count = 0
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init })
    if (url.endsWith('/capabilities')) return Response.json({ features: { mediaTranscoding: true } })
    count++
    return Response.json({ jobId, kind: 'video', state: count === 1 ? 'queued' : count === 2 ? 'processing' : 'ready',
      stage: count === 2 ? 'converting' : 'ready', progress: 50,
      ...(count === 3 ? { url: 'https://parse.test/compatible.mp4?sig=fresh' } : {}) }, { status: count < 3 ? 202 : 200 })
  }) as typeof fetch
  const value = await prepareRemoteMedia({ server: 'https://parse.test', fileId, token: 'secret', media,
    fetchImpl, options: { onStatus: (text) => statuses.push(text) } })
  assert.equal(value.dataUrl, 'https://parse.test/compatible.mp4?sig=fresh')
  assert.ok(statuses.some((text) => text.includes('排队')))
  assert.ok(statuses.some((text) => text.includes('50%')))
  assert.equal((requests[1]!.init!.headers as Record<string, string>).Authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(String(requests[1]!.init!.body)), { partPath: 'ppt/media/a.wmv', kind: 'video', retry: false })
})
test('keeps local/external media and explicitly disabled older services unchanged', async () => {
  resetCapabilitiesCacheForTests()
  let calls = 0
  const fetchImpl = (async () => { calls++; return Response.json({ features: { mediaTranscoding: false } }) }) as typeof fetch
  assert.deepEqual(await prepareRemoteMedia({ server: 'https://parse.test', fileId, media, fetchImpl }), media)
  const external = { ...media, dataUrl: 'https://external.test/movie.wmv' }
  assert.deepEqual(await prepareRemoteMedia({ server: 'https://parse.test', fileId, media: external, fetchImpl }), external)
  assert.equal(calls, 1)
})
test('surfaces durable task failures and cancels polling when the slide closes', async () => {
  resetCapabilitiesCacheForTests()
  const fetchImpl = (async (url: string) => Response.json(url.endsWith('/capabilities')
    ? { features: { mediaTranscoding: true } }
    : { jobId, kind: 'video', state: 'failed', errorCode: 'media_decode_failed' })) as typeof fetch
  await assert.rejects(prepareRemoteMedia({ server: 'https://parse.test', fileId, media, fetchImpl }), /无法解码/)
  const controller = new AbortController()
  let polls = 0
  const queued = (async () => { polls++; return Response.json({ jobId, state: 'queued' }) }) as typeof fetch
  const pending = prepareRemoteMedia({ server: 'https://parse.test', fileId, media, fetchImpl: queued,
    options: { signal: controller.signal, onStatus: (text) => { if (text.includes('排队')) controller.abort() } } })
  await assert.rejects(pending)
  assert.equal(polls, 1)
})
test('routes a small PPT containing audio/video to preparation without inflating an oversized types entry', async () => {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types><Default Extension="wmv" ContentType="video/x-ms-wmv"/></Types>')
  assert.equal(await pptxHasMedia(new Blob([await zip.generateAsync({ type: 'arraybuffer' })])), true)
  zip.file('[Content_Types].xml', '<Types><Default Extension="png" ContentType="image/png"/></Types>')
  assert.equal(await pptxHasMedia(new Blob([await zip.generateAsync({ type: 'arraybuffer' })])), false)
  zip.file('[Content_Types].xml', 'x'.repeat(1024 * 1024 + 1))
  assert.equal(await pptxHasMedia(new Blob([await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' })])), true)
})
