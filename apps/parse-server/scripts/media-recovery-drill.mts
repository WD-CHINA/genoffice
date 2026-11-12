/** Explicit local-container fault drill; business originals remain read-only. */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import JSZip from 'jszip'
const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf('--' + name)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
assert.ok(
  process.argv.includes('--allow-kill'),
  '--allow-kill is required for this explicit fault drill',
)
const out = resolve(option('out', '/tmp/genoffice-media-production'))
const a = option('url-a', 'http://127.0.0.1:18787'),
  b = option('url-b', 'http://127.0.0.1:18788')
const containers = [
  option('container-a', 'genoffice-validation-app-a-1'),
  option('container-b', 'genoffice-validation-app-b-1'),
]
assert.ok(
  containers.every((name) => /^genoffice-(validation|test-cleanup)-app-[ab]-1$/.test(name)),
  'only local validation containers may be killed',
)
const projects = containers.map((name) =>
  execFileSync(
    'docker',
    ['inspect', '--format', '{{ index .Config.Labels "com.docker.compose.project" }}', name],
    { encoding: 'utf8' },
  ).trim(),
)
assert.ok(
  projects.every(
    (project) =>
      project === projects[0] &&
      ['genoffice-validation', 'genoffice-test-cleanup'].includes(project),
  ),
  'fault targets must belong to one isolated validation project',
)
assert.ok(
  containers.every((name) => name.startsWith(projects[0] + '-')),
  'container names must match the inspected project',
)
for (const base of [a, b]) {
  const url = new URL(base)
  assert.ok(
    url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port,
    'fault drill requires local loopback HTTP endpoints',
  )
}
const token = process.env.PARSE_SERVER_TOKEN ?? ''
const report: any = { events: [], warm: [] }
const save = () => writeFile(join(out, 'recovery.json'), JSON.stringify(report, null, 2))
const request = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof Uint8Array ? new Uint8Array(body).buffer : JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  })
  const value = (await response.json()) as any
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`)
  return value
}
const ready = async (fileId: string, opened: any, deadlineMs = 240_000) => {
  const deadline = Date.now() + deadlineMs
  let state = opened
  while (['queued', 'processing'].includes(state.state)) {
    assert.ok(Date.now() < deadline, 'media recovery timed out')
    await delay(200)
    let received = false
    for (const base of [b, a]) {
      try {
        state = await request(base, `/v1/files/${fileId}/media/${opened.jobId}`)
        received = true
        break
      } catch {
        /* The killed HTTP instance may still be restarting. */
      }
    }
    if (!received) continue
  }
  assert.equal(state.state, 'ready', JSON.stringify(state))
  return state
}
const healthy = async () => {
  for (const base of [a, b]) {
    let ok = false
    for (let n = 0; n < 120; n++) {
      try {
        await request(base, '/v1/health')
        ok = true
        break
      } catch {
        await delay(250)
      }
    }
    assert.ok(ok, 'server did not restart')
  }
}
try {
  for (let n = 0; ; n++) {
    const health = await request(a, '/v1/health')
    if (!health.media.jobs.processing && !health.media.jobs.queued) break
    assert.ok(n < 240, 'previous media work did not finish')
    await delay(500)
  }
  const corpus = JSON.parse(await readFile(join(out, 'transcode.json'), 'utf8'))
  const browser = JSON.parse(await readFile(join(out, 'browser-original.json'), 'utf8'))
  assert.equal(browser.native.length, 26)
  const healthBefore = await Promise.all([request(a, '/v1/health'), request(b, '/v1/health')])
  for (const sample of browser.native) {
    const document = browser.documents.find((d: any) => d.name === sample.name)
    const state = await request(b, `/v1/files/${document.fileId}/media`, {
      partPath: sample.part,
      kind: sample.kind,
    })
    assert.equal(state.state, 'ready')
    assert.equal(state.jobId, sample.preparation.jobId)
    assert.equal(state.cacheHit, true)
    report.warm.push({
      name: sample.name,
      part: sample.part,
      strategy: state.strategy,
      cacheHit: state.cacheHit,
    })
  }
  const afterWarm = await Promise.all([request(a, '/v1/health'), request(b, '/v1/health')])
  assert.equal(
    afterWarm.reduce((n, h) => n + h.media.counters.probes, 0),
    healthBefore.reduce((n, h) => n + h.media.counters.probes, 0),
  )
  const original = corpus.documents.find((d: any) => d.name.startsWith('47e66'))
  assert.ok(original)
  const bytes = await readFile(original.source)
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(end >= 0 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length)
  const header = Buffer.from(bytes.subarray(0, end + 22)),
    comment = Buffer.from('media-dedupe-' + randomUUID())
  header.writeUInt16LE(comment.length, end + 20)
  const duplicate = await request(a, '/v2/files', Buffer.concat([header, comment]))
  const firstMedia = original.media.find((m: any) => m.part.endsWith('media1.mp4'))
  const shared = await ready(
    duplicate.fileId,
    await request(b, `/v1/files/${duplicate.fileId}/media`, {
      partPath: firstMedia.part,
      kind: 'video',
    }),
  )
  assert.equal(shared.cacheHit, true)
  report.crossFileCache = { fileId: duplicate.fileId, strategy: shared.strategy, cacheHit: true }
  for (const container of containers)
    execFileSync('docker', ['restart', container], { timeout: 60_000 })
  await healthy()
  const originalDoc = browser.documents.find((d: any) => d.name === original.name)
  const restartWarm = await request(a, `/v1/files/${originalDoc.fileId}/media`, {
    partPath: firstMedia.part,
    kind: 'video',
  })
  assert.equal(restartWarm.state, 'ready')
  assert.equal(restartWarm.cacheHit, true)
  const restarted = await Promise.all([request(a, '/v1/health'), request(b, '/v1/health')])
  assert.equal(
    restarted.reduce((n, h) => n + h.media.counters.probes, 0),
    0,
  )
  report.restart = 'ready without probing or re-encoding'
  await save()
  // Make a unique, still-valid MP4 input so a previous fault drill cannot turn
  // this into a cached force-conversion hit. Only a temporary PPTX is changed.
  const zip = await JSZip.loadAsync(bytes),
    part = 'ppt/media/media3.mp4'
  const video = await zip.file(part)!.async('nodebuffer')
  const free = Buffer.alloc(44)
  free.writeUInt32BE(free.length)
  free.write('free', 4)
  free.write(randomUUID(), 8)
  zip.file(part, Buffer.concat([video, free]))
  const upload = await request(
    a,
    '/v2/files',
    await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }),
  )
  let state = await request(a, `/v1/files/${upload.fileId}/media`, {
    partPath: part,
    kind: 'video',
    retry: true,
  })
  const started = Date.now(),
    deadline = started + 60_000
  while (state.stage !== 'converting' && ['queued', 'processing'].includes(state.state)) {
    assert.ok(Date.now() < deadline, 'encoder never started')
    await delay(100)
    state = await request(b, `/v1/files/${upload.fileId}/media/${state.jobId}`)
  }
  assert.equal(state.stage, 'converting', JSON.stringify(state))
  const owner = containers.find((name) =>
    execFileSync('docker', ['top', name, '-eo', 'pid,args'], { encoding: 'utf8' })
      .split('\n')
      .some((line) => line.includes('ffmpeg') && line.includes(state.jobId)),
  )
  assert.ok(owner, 'cannot identify the local encoder owner')
  report.events.push({
    action: 'SIGKILL',
    container: owner,
    jobId: state.jobId,
    at: new Date().toISOString(),
  })
  await save()
  execFileSync('docker', ['kill', '--signal', 'KILL', owner], { timeout: 10_000 })
  const recovered = await ready(upload.fileId, state)
  assert.equal(recovered.jobId, state.jobId)
  assert.equal(recovered.strategy, 'transcode')
  const peer = owner === containers[0] ? b : a
  assert.ok(
    (await request(peer, '/v1/health')).media.counters.recovered >= 1,
    'surviving instance did not take over',
  )
  execFileSync('docker', ['start', owner], { timeout: 30_000 })
  await healthy()
  const recoveredHealth = await Promise.all([request(a, '/v1/health'), request(b, '/v1/health')])
  assert.ok(recoveredHealth.reduce((n, h) => n + h.media.counters.recovered, 0) >= 1)
  const range = await fetch(recovered.url, { headers: { Range: 'bytes=0-31' } })
  assert.equal(range.status, 206)
  assert.equal((await range.arrayBuffer()).byteLength, 32)
  report.recovery = {
    jobId: state.jobId,
    elapsedMs: Date.now() - started,
    strategy: recovered.strategy,
    sameJobId: true,
    range: 206,
    takeoverBy: owner === containers[0] ? containers[1] : containers[0],
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  process.exitCode = 1
}
await save()
console.log(JSON.stringify(report))
