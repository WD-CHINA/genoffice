/** Local, read-only corpus input. Reports contain hashes and filenames, never document text. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}
const input = resolve(option('input'))
if (!option('input') && !option('reopen-report')) throw new Error('--input or --reopen-report is required')
const base = option('url', 'http://127.0.0.1:18787').replace(/\/$/, '')
const output = resolve(option('out', '/tmp/genoffice-corpus.json'))
const restartContainer = option('restart-container')
const token = process.env.PARSE_SERVER_TOKEN ?? ''
const headers = token ? { Authorization: `Bearer ${token}` } : {}
const request = (path: string, init: RequestInit = {}) => fetch(base + path, {
  ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(60_000),
})
async function json(path: string, init: RequestInit = {}) {
  const response = await request(path, init)
  const body = await response.json() as any
  assert.ok(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(body)}`)
  return body
}
async function ready(fileId: string) {
  const started = performance.now()
  const opened = await json('/v2/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId }),
  })
  const deadline = Date.now() + 600_000
  let previewAtMs: number | undefined
  for (;;) {
    const status = await json(`/v2/sessions/${opened.sessionId}`)
    if (status.previewable && previewAtMs === undefined) previewAtMs = performance.now() - started
    if (status.state === 'ready') return { ...opened, ...status,
      readyMs: performance.now() - started, previewAtMs }
    assert.ok(!['failed', 'cancelled'].includes(status.state), JSON.stringify(status))
    assert.ok(Date.now() < deadline, 'corpus parse timed out')
    await delay(100)
  }
}
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, normalized(item)]),
  )
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    const url = new URL(value)
    if (url.searchParams.has('sig')) {
      url.searchParams.delete('sig'); url.searchParams.delete('exp')
      return url.pathname + url.search
    }
  }
  return value
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(normalized(value))).digest('hex')
async function unitHashes(session: any, format: string) {
  const document = await json(`/v2/sessions/${session.sessionId}/document`)
  const count = Number(document.model?.unitCount ?? session.model?.unitCount ?? 0)
  assert.ok(Number.isSafeInteger(count) && count > 0, `invalid unitCount ${count}`)
  const hashes: string[] = []
  for (let index = 0; index < count; index++) {
    const unit = await json(`/v2/sessions/${session.sessionId}/units/${index}`)
    hashes.push(digest(unit))
  }
  if (format === 'pdf') {
    const range = await request(`/v1/files/${session.fileId}/content`, { headers: { Range: 'bytes=0-31' } })
    assert.equal(range.status, 206)
    assert.equal((await range.arrayBuffer()).byteLength, 32)
  }
  return { unitCount: count, hashes }
}
async function pdfRange(fileId: string) {
  const response = await request(`/v1/files/${fileId}/content`, { headers: { Range: 'bytes=0-31' } })
  assert.equal(response.status, 206)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(bytes.length, 32)
  assert.ok(bytes.includes(Buffer.from('%PDF-')))
  return createHash('sha256').update(bytes).digest('hex')
}
const previous = option('reopen-report')
  ? JSON.parse(await readFile(option('reopen-report'), 'utf8')) as any : undefined
const files: string[] = previous ? previous.documents.filter((item: any) => item.status === 'passed').map((item: any) => item.name)
  : (await readdir(input)).filter((name) =>
    !name.startsWith('.') && !name.startsWith('~$') && /\.(pptx|docx|pdf)$/i.test(name),
  ).sort()
assert.ok(files.length > 0, 'no supported documents')
const report: any = { startedAt: new Date().toISOString(), base, status: 'running', documents: [],
  scope: 'API model completeness and restart equivalence; visual fidelity requires a separate browser/reference check' }
await mkdir(dirname(output), { recursive: true })
const save = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
try {
  report.beforeHealth = await json('/v1/health')
  for (const name of files) {
    const path = join(input, name)
    const prior = previous?.documents.find((item: any) => item.name === name)
    const item: any = { name: basename(path), bytes: prior?.bytes ?? (await stat(path)).size, format: extname(path).slice(1), status: 'running' }
    report.documents.push(item)
    try {
      const upload = prior ?? await json('/v2/files', { method: 'POST', body: await openAsBlob(path) })
      item.fileId = upload.fileId
      if (item.format === 'pdf') {
        item.rangeHash = await pdfRange(upload.fileId)
      } else {
        const session = await ready(upload.fileId)
        Object.assign(item, await unitHashes({ ...session, fileId: upload.fileId }, item.format), {
          readyMs: session.readyMs, previewAtMs: session.previewAtMs,
        })
        await request(`/v2/sessions/${session.sessionId}`, { method: 'DELETE' })
      }
      await json('/v2/library', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId: upload.fileId }) })
      item.status = 'passed'
      if (prior) {
        assert.equal(JSON.stringify(item.hashes), JSON.stringify(prior.hashes), 'reopened model differs')
        assert.equal(item.rangeHash, prior.rangeHash, 'reopened PDF range differs')
      }
      console.log(JSON.stringify({ name, unitCount: item.unitCount, readyMs: item.readyMs }))
    } catch (error) {
      item.status = 'failed'; item.error = String(error)
      console.error(name, item.error)
    }
    await save()
  }
  report.afterHealth = await json('/v1/health')
  if (previous) assert.equal(report.afterHealth.artifacts.sourceParsesStarted, report.beforeHealth.artifacts.sourceParsesStarted)
  if (restartContainer) {
    execFileSync('docker', ['restart', restartContainer], { timeout: 60_000, stdio: 'pipe' })
    let healthy = false
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await json('/v1/health'); healthy = true; break } catch { await delay(200) }
    }
    assert.ok(healthy, 'server did not restart')
    for (const item of report.documents.filter((document: any) => document.status === 'passed')) {
      if (item.format === 'pdf') {
        item.restartEquivalent = (await pdfRange(item.fileId)) === item.rangeHash
        assert.equal(item.restartEquivalent, true)
        continue
      }
      const session = await ready(item.fileId)
      const reopened = await unitHashes({ ...session, fileId: item.fileId }, item.format)
      item.restartEquivalent = JSON.stringify(reopened.hashes) === JSON.stringify(item.hashes)
      item.reopenMs = session.readyMs
      assert.equal(item.restartEquivalent, true, `${item.name}: model changed after restart`)
      await request(`/v2/sessions/${session.sessionId}`, { method: 'DELETE' })
      await save()
    }
    report.afterRestartHealth = await json('/v1/health')
    assert.equal(report.afterRestartHealth.artifacts.sourceParsesStarted, 0)
  }
  report.status = report.documents.every((document: any) => document.status === 'passed') ? 'passed' : 'failed'
  if (report.status === 'failed') process.exitCode = 1
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
} finally {
  report.completedAt = new Date().toISOString()
  await save()
}
