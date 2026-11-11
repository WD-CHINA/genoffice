/** Actual parse-server part routes and Viewer playback. Private evidence stays in --out. */
import assert from 'node:assert/strict'
import { openAsBlob } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const option = (key: string, fallback = '') => {
  const index = process.argv.indexOf('--' + key)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}
const output = resolve(option('out', '/tmp/genoffice-media-validation'))
const phase = option('phase', 'original')
assert.ok(['original', 'converted'].includes(phase))
const base = option('server', 'http://127.0.0.1:18787')
const token = process.env.PARSE_SERVER_TOKEN ?? ''
const automatic = process.argv.includes('--automatic')
process.env.PARSE_SERVER_URL = base
const source = JSON.parse(await readFile(join(output, 'transcode.json'), 'utf8'))
const report: any = process.argv.includes('--app-only')
  ? { ...JSON.parse(await readFile(join(output, `browser-${phase}.json`), 'utf8')), app: [] }
  : { phase, scope: 'Muted browser decoding and Viewer preview/show; not audible listening or Office timing comparison', native: [], documents: [], app: [] }
const save = () => writeFile(join(output, `browser-${phase}.json`), JSON.stringify(report, null, 2) + '\n')
await mkdir(join(output, 'screenshots'), { recursive: true })
const request = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(base + path, { ...init,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
    signal: AbortSignal.timeout(120_000) })
  const body = await response.text()
  const data = body ? JSON.parse(body) as any : undefined
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(data)}`)
  return data
}
const frontend = await createServer({ configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: { host: '127.0.0.1', port: 11019, strictPort: true },
  plugins: [{ name: 'media-drill-page', configureServer(server) {
    server.middlewares.use('/__media_drill', (_req, res) => {
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Media validation</title><body>Media validation</body>')
    })
  } }] })
await frontend.listen()
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
report.browserVersion = browser.version()
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
// tsx/esbuild preserves nested function names using this helper; serialized
// Playwright evaluators run in a different realm from the Node helper.
await page.addInitScript('globalThis.__name = (fn) => fn')
try {
  await page.goto('http://127.0.0.1:11019/__media_drill')
  for (const document of (process.argv.includes('--app-only') ? [] : source.documents.filter((d: any) => d.media.length))) {
    const path = phase === 'original' ? document.source : document.converted
    assert.ok(path, 'converted PPTX not generated')
    const uploaded = await request('/v2/files', { method: 'POST', body: await openAsBlob(path) })
    const record: any = { name: document.name, fileId: uploaded.fileId, units: [], status: 'running' }
    report.documents.push(record)
    const session = await request('/v2/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: uploaded.fileId }) })
    const deadline = Date.now() + 600_000
    let state: any
    for (;;) {
      state = await request(`/v2/sessions/${session.sessionId}`)
      if (state.state === 'ready') break
      assert.ok(!['failed', 'cancelled'].includes(state.state), JSON.stringify(state))
      assert.ok(Date.now() < deadline, 'parse timed out')
      await delay(250)
    }
    for (let index = 0; index < state.model.unitCount; index++) {
      const unit = await request(`/v2/sessions/${session.sessionId}/units/${index}`)
      if (unit.mediaRefs?.length) record.units.push({ index, media: unit.mediaRefs })
    }
    record.unitCount = state.model.unitCount
    record.status = 'passed'
    await request(`/v2/sessions/${session.sessionId}`, { method: 'DELETE' })
    for (const media of document.media) {
      const asset = source.assets.find((a: any) => a.sha256 === media.sha256)
      const extension = asset.conversion?.output?.split('.').pop()
      const part = phase === 'original' ? media.part : `ppt/media/compatible-${media.sha256}.${extension}`
      const kind = asset.declaredMime.startsWith('audio/') ? 'audio' : 'video'
      let url = `${base}/v1/files/${uploaded.fileId}/parts/${part.split('/').map(encodeURIComponent).join('/')}`
      const sample: any = { name: document.name, part, kind }
      report.native.push(sample)
      try {
        if (automatic) {
          let prepared = await request(`/v1/files/${uploaded.fileId}/media`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ partPath: part, kind }) })
          const traces = [prepared.stage]
          const deadline = Date.now() + 30 * 60_000
          while (['queued', 'processing'].includes(prepared.state)) {
            assert.ok(Date.now() < deadline, 'media preparation timed out')
            await delay(150)
            prepared = await request(`/v1/files/${uploaded.fileId}/media/${prepared.jobId}`)
            if (traces.at(-1) !== prepared.stage) traces.push(prepared.stage)
          }
          sample.preparation = { ...prepared, url: undefined, stages: traces }
          assert.equal(prepared.state, 'ready', JSON.stringify(prepared))
          url = prepared.url
        }
        const range = await fetch(url, { headers: { Range: 'bytes=0-31', ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
        const rangeBytes = (await range.arrayBuffer()).byteLength
        Object.assign(sample, { rangeStatus: range.status, rangeBytes,
          contentType: range.headers.get('content-type'), contentRange: range.headers.get('content-range') })
        // Deflated source ZIP entries currently fall back to a complete 200.
        // Keep this transport limitation separate from actual decoding results.
        sample.rangeSupported = range.status === 206 && rangeBytes === 32
        if (phase === 'converted' || automatic) assert.ok(sample.rangeSupported, 'prepared resource lacks Range support')
        sample.playback = await page.evaluate(async ({ url, kind }) => {
          const element = document.createElement(kind) as HTMLMediaElement
          element.muted = true; element.controls = true; element.preload = 'auto'
          document.body.replaceChildren(element)
          let error: string | undefined
          element.addEventListener('error', () => { error = `${element.error?.code}: ${element.error?.message}` })
          const deadline = performance.now() + 25_000
          element.src = url
          const wait = async (test: () => boolean) => {
            while (!test()) {
              if (error) throw new Error(error)
              if (performance.now() > deadline) throw new Error('media wait timed out')
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          }
          try {
            await wait(() => element.readyState >= 2)
            await element.play()
            await wait(() => element.currentTime >= Math.min(.35, element.duration * .6) || element.ended)
            const advanced = element.currentTime
            element.pause()
            if (element.duration > .5) {
              const target = element.duration / 2
              element.currentTime = target
              await wait(() => !element.seeking && Math.abs(element.currentTime - target) < .3)
              await element.play()
              await wait(() => element.currentTime > target + .15 || element.ended)
            }
            return { duration: element.duration, advanced, afterSeek: element.currentTime,
              width: kind === 'video' ? (element as HTMLVideoElement).videoWidth : undefined,
              height: kind === 'video' ? (element as HTMLVideoElement).videoHeight : undefined,
              videoFrames: kind === 'video' ? (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames : undefined,
              decodedAudioBytes: (element as any).webkitAudioDecodedByteCount,
              readyState: element.readyState }
          } finally {
            element.pause(); element.removeAttribute('src'); element.load(); element.remove()
          }
        }, { url, kind })
        if (kind === 'video') assert.ok(sample.playback.width > 0 && sample.playback.videoFrames > 0)
        sample.status = 'passed'
      } catch (error) { sample.status = 'failed'; sample.error = String(error) }
      await save()
      console.log(JSON.stringify({ phase, document: document.name, part, status: sample.status, error: sample.error }))
    }
  }
  // Exercise the actual Viewer, selecting one recognized media slide per document.
  for (const document of report.documents) {
    const unit = document.units[0]
    if (!unit) continue
    const sample: any = { name: document.name, index: unit.index, errors: [] }
    report.app.push(sample)
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    await context.addInitScript('globalThis.__name = (fn) => fn')
    await context.addInitScript(({ fileId, page }) => localStorage.setItem('genoffice.reading-position.v1', JSON.stringify({ [fileId]: { page, savedAt: Date.now() } })), { fileId: document.fileId, page: unit.index })
    const app = await context.newPage()
    app.setDefaultTimeout(15_000)
    app.on('pageerror', (error) => sample.errors.push(error.message))
    try {
      const params = new URLSearchParams({ parse: 'server', server: base, fileId: document.fileId, name: document.name,
        ...(token ? { token } : {}) })
      await app.goto('http://127.0.0.1:11019/?' + params)
      const frame = app.frameLocator('iframe')
      const play = frame.getByRole('button', { name: /播放视频|播放音频/ }).first()
      await play.waitFor({ timeout: 90_000 })
      sample.step = 'preview'; await save()
      try {
        await play.click({ timeout: 3000 })
        sample.previewPointerReachable = true
      } catch {
        sample.previewPointerReachable = false
        // Off-slide audio can sit behind the toolbar. Probe its component
        // separately, and explicitly preserve the interaction warning.
        await play.dispatchEvent('click')
      }
      const media = frame.locator('video, audio').first()
      await media.waitFor({ timeout: 30_000 })
      await media.evaluate((el: HTMLMediaElement) => { el.muted = true; return el.play() })
      await app.waitForTimeout(700)
      sample.preview = await media.evaluate((el: HTMLMediaElement) => ({ currentTime: el.currentTime, duration: el.duration, error: el.error?.code, readyState: el.readyState }))
      assert.ok(sample.preview.currentTime > 0 && !sample.preview.error)
      await app.screenshot({ path: join(output, 'screenshots', `${phase}-${document.fileId.slice(0, 12)}.png`) })
      await frame.locator('body').press('Escape')
      sample.step = 'show'; await save()
      await frame.getByRole('button', { name: '开始放映', exact: true }).click()
      const showMedia = frame.locator('video, audio').first()
      await showMedia.waitFor({ state: 'attached', timeout: 30_000 })
      const kind = await showMedia.evaluate((el: HTMLMediaElement) => {
        el.muted = true; el.pause(); return el.tagName
      })
      const hit = kind === 'VIDEO' ? showMedia : showMedia.locator('..')
      try {
        await hit.click({ timeout: 3000 })
        sample.showPointerReachable = true
      } catch {
        sample.showPointerReachable = false
        await hit.dispatchEvent('click')
      }
      await app.waitForTimeout(700)
      sample.show = await showMedia.evaluate((el: HTMLMediaElement) => ({ currentTime: el.currentTime, duration: el.duration, error: el.error?.code, readyState: el.readyState }))
      assert.ok(sample.show.currentTime > 0 && !sample.show.error)
      await app.screenshot({ path: join(output, 'screenshots', `${phase}-${document.fileId.slice(0, 12)}-show.png`) })
      await frame.locator('body').press('Escape')
      delete sample.step
      sample.status = sample.previewPointerReachable && sample.showPointerReachable ? 'passed' : 'passed_with_warnings'
    } catch (error) {
      sample.status = 'failed'; sample.error = String(error)
      await app.screenshot({ path: join(output, 'screenshots', `${phase}-${document.fileId.slice(0, 12)}-failed.png`) }).catch(() => undefined)
    }
    await context.close(); await save()
    console.log(JSON.stringify({ phase, app: document.name, status: sample.status, error: sample.error }))
  }
  const samples = [...report.native, ...report.app]
  report.status = samples.some((s: any) => s.status === 'failed') ? 'failed'
    : samples.some((s: any) => s.status === 'passed_with_warnings' || s.rangeSupported === false) ? 'passed_with_warnings' : 'passed'
  await save()
} finally { await browser.close(); await frontend.close() }
