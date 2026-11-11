/** Exercise a large *body XML* fixture, with cached reads and HTTP probes during parsing. */
import assert from 'node:assert/strict'
import { openAsBlob } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}
if (!option('file')) throw new Error('--file is required')
const base = option('url', 'http://127.0.0.1:18787')
const output = option('out', '/tmp/genoffice-body-load.json')
const headers = { Authorization: `Bearer ${process.env.PARSE_SERVER_TOKEN ?? ''}` }
async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers },
    signal: AbortSignal.timeout(60_000) })
  const body = await response.json() as any
  assert.ok(response.ok, `HTTP ${response.status}: ${JSON.stringify(body)}`)
  return body
}
const report: any = { startedAt: new Date().toISOString(), status: 'running', samples: [], cacheReads: [] }
let sampling = true
const probe = (async () => {
  while (sampling) {
    const started = performance.now()
    try {
      const health = await json('/v1/health')
      report.samples.push({ elapsedMs: performance.now() - started, at: Date.now(),
        rss: health.memory.rss, childRss: health.childProcesses?.rssBytes ?? 0,
        running: health.parseQueue.running, queued: health.parseQueue.queued })
    } catch (error) { report.samples.push({ error: String(error), at: Date.now() }) }
    await delay(500)
  }
})()
try {
  const upload = await json('/v2/files', { method: 'POST', body: await openAsBlob(option('file')) })
  report.fileId = upload.fileId
  const started = performance.now()
  const opened = await json('/v2/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId: upload.fileId }) })
  const warmId = option('warm-session')
  const warmReads = warmId ? (async () => {
    for (let index = 0; index < 50; index++) {
      const at = performance.now()
      await json(`/v2/sessions/${warmId}/units/0`)
      report.cacheReads.push(performance.now() - at)
      await delay(100)
    }
  })() : Promise.resolve()
  const deadline = Date.now() + 900_000
  let firstPreviewMs: number | undefined
  for (;;) {
    const status = await json(`/v2/sessions/${opened.sessionId}`)
    if (status.previewable && firstPreviewMs === undefined) firstPreviewMs = performance.now() - started
    if (status.state === 'ready') break
    assert.ok(!['failed', 'cancelled'].includes(status.state), JSON.stringify(status))
    assert.ok(Date.now() < deadline, 'parse deadline exceeded')
    await delay(250)
  }
  await warmReads
  report.readyMs = performance.now() - started
  report.firstPreviewMs = firstPreviewMs
  const document = await json(`/v2/sessions/${opened.sessionId}/document`)
  report.model = document.model
  const count = Number(document.model.unitCount)
  assert.ok(count > 1)
  report.checkedUnits = []
  for (const index of [...new Set([0, Math.floor(count / 2), count - 1])]) {
    const unit = await json(`/v2/sessions/${opened.sessionId}/units/${index}`)
    const text = JSON.stringify(unit)
    if (index === 0) assert.ok(text.includes('BODY-0 '), 'first paragraph missing')
    if (index === count - 1) assert.ok(text.includes(`BODY-${option('last-index', '65535')} `), 'last paragraph missing')
    report.checkedUnits.push({ index, blocks: unit.blocks?.length, bytes: text.length })
  }
  report.health = await json('/v1/health')
  report.status = 'passed'
  await fetch(`${base}/v2/sessions/${opened.sessionId}`, { method: 'DELETE', headers })
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
} finally {
  sampling = false
  await probe
  report.completedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, readyMs: report.readyMs, firstPreviewMs: report.firstPreviewMs,
    units: report.model?.unitCount, error: report.error, samples: report.samples.length }))
}
