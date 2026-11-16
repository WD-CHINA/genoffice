import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { createServer } from 'vite'
import { openPptx, duplicateSlide, materializeSlide, savePptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../../parse-server/src/server.ts'
import { root, app } from './paths.mjs'

const duration = Number(process.env.SOAK_SECONDS || '0')
assert.ok(Number.isFinite(duration) && duration >= 0)
const dir = await mkdtemp(join(tmpdir(), 'viewer-resilience-'))
const output = process.env.RESILIENCE_REPORT || '/tmp/genoffice-viewer-resilience.json'
const port = Number(process.env.VIEWER_TEST_PORT || '11017')
const mobile = process.env.MOBILE_VIEWER === '1'
const origin = `http://127.0.0.1:${port}`
const token = 'resilience-test-token'
const backend = await createParseServer({
  dataDir: dir,
  token,
  allowedOrigins: [origin],
  publicBaseUrl: origin,
})
process.env.PARSE_SERVER_URL = backend.url
const vite = await createServer({
  configFile: resolve(app, 'vite.config.ts'),
  server: { host: '127.0.0.1', port, strictPort: true },
})
await vite.listen()
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const report: any = {
  startedAt: new Date().toISOString(),
  requestedSoakSeconds: duration,
  status: 'running',
  viewport: mobile ? 'mobile' : 'desktop',
  samples: [],
}
const save = () => writeFile(output, JSON.stringify(report, null, 2))
try {
  const fixture = await openPptx(
    new Uint8Array(
      await readFile(
        resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
      ),
    ),
  )
  for (let index = 0; index < fixture.deck.slides.length; index++) materializeSlide(fixture, index)
  const wantedSlides = Number(process.env.TEST_SLIDES || '50')
  while (fixture.deck.slides.length < wantedSlides) {
    assert.ok(duplicateSlide(fixture, Math.floor(fixture.deck.slides.length / 2)))
  }
  const fixtureBytes = Buffer.from(await savePptx(fixture))
  const upload = await fetch(`${backend.url}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fixtureBytes,
  })
  assert.equal(upload.status, 201)
  const { fileId } = (await upload.json()) as { fileId: string }
  report.fileId = fileId
  report.backendUrl = backend.url
  await save()
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    isMobile: mobile,
    hasTouch: mobile,
  })
  const faults: string[] = []
  page.on('pageerror', (e) => faults.push(e.message))
  page.on('response', (r) => {
    if (r.url().includes('/v1/') && r.status() >= 400) faults.push(`${r.status()} ${r.url()}`)
  })
  const reads = new Map<number, number>()
  page.on('request', (request) => {
    const match = /\/layout\/slides\/(\d+)/.exec(request.url())
    if (match) reads.set(+match[1], (reads.get(+match[1]) || 0) + 1)
  })
  let releaseNext!: () => void
  const gate = new Promise<void>((done) => {
    releaseNext = done
  })
  let delayNext = true
  let prefetchStarted = false
  await page.route('**/layout/slides/*', async (route) => {
    const index = Number(route.request().url().split('/').pop())
    if (index === 2 && delayNext) {
      prefetchStarted = true
      await gate
    }
    const response = await route.fetch()
    const body = await response.json()
    if (index === 1) {
      // Two clicks: hide a visible shape, then advance. A preload must not undo click one.
      const shape =
        body.slide.elements.find((e: any) => e.type === 'text') || body.slide.elements[0]
      assert.ok(shape?.id, 'fixture needs a visible shape')
      body.playback.animations = [
        {
          sourceId: shape.id,
          targetName: 'test',
          effect: 'fadeOut',
          trigger: 'onClick',
          durationMs: 2000,
          delayMs: 0,
        },
      ]
    }
    await route.fulfill({ response, json: body })
  })
  await page.goto(`${origin}/preview.html?fileId=${fileId}&token=${token}`)
  await expect(page.getByLabel('开始放映')).toBeVisible({ timeout: 90_000 })
  await page.getByLabel('开始放映').click()
  await expect(page.locator('.slideshow')).toBeVisible({ timeout: 60_000 })
  const jump = async (number: number) => {
    await page.evaluate((number) => {
      for (const key of [...('0000' + number), 'Enter']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }
    }, number)
    await expect(page.locator('.ss-counter')).toHaveText(new RegExp(`^\\s*${number}\\s*/`))
  }
  await jump(2)
  await expect.poll(() => prefetchStarted).toBe(true)
  // Jumping enters in the finished animation state. Re-enter forward for click testing.
  await jump(1)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.ss-counter')).toHaveText(/^\s*2\s*\//)
  await page.waitForTimeout(300)
  const before = await page.locator('.ss-frame canvas').first().screenshot()
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(600)
  const during = await page.locator('.ss-frame canvas').first().screenshot()
  assert.notDeepEqual(before, during, 'animation must visibly be in progress')
  delayNext = false
  releaseNext()
  await expect.poll(() => reads.get(2) || 0).toBeGreaterThan(0)
  await page.waitForTimeout(1600)
  const after = await page.locator('.ss-frame canvas').first().screenshot()
  assert.notDeepEqual(after, during, 'animation must continue to its finished state')
  // If preloading resets the two-second animation at 600 ms, this click would only
  // finish that animation instead of advancing to page three.
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.ss-counter')).toHaveText(/^\s*3\s*\//)
  report.animationPreload = 'passed'
  const countText = (await page.locator('.ss-counter').textContent()) || ''
  const total = Number(/\/\s*(\d+)/.exec(countText)?.[1])
  assert.ok(total >= 4, JSON.stringify({ countText, total }))
  for (let i = 0; i < 40; i++) await jump(1 + ((i * 7) % total))
  await jump(total)
  await page.waitForTimeout(2000)
  const settledReads = [...reads.values()].reduce((a, b) => a + b, 0)
  await page.waitForTimeout(2000)
  assert.equal(
    [...reads.values()].reduce((a, b) => a + b, 0),
    settledReads,
    'settled page must not continuously refetch',
  )
  report.rapidJumps = { passed: 40, modelReads: settledReads, total }
  const cdp = await page.context().newCDPSession(page)
  const start = Date.now()
  let retainedBaseline: number | undefined
  let sample = 0
  let lastSampleAt = Date.now()
  do {
    assert.ok(Date.now() - lastSampleAt < 90_000, 'continuous run interrupted for over 90 seconds')
    lastSampleAt = Date.now()
    // Include a 20-minute idle page to exercise heartbeat renewal without model reads.
    if (sample === 0 || Date.now() - start > 20 * 60_000) {
      await jump(1 + ((sample * 7) % total))
    }
    await cdp.send('HeapProfiler.collectGarbage')
    const memory = await cdp.send('Runtime.getHeapUsage')
    if (sample === 5) retainedBaseline = memory.usedSize
    if (retainedBaseline !== undefined) {
      assert.ok(
        memory.usedSize < retainedBaseline + 64 * 1024 * 1024,
        'retained heap grew by over 64 MiB',
      )
    }
    report.samples.push({
      elapsedSeconds: Math.round((Date.now() - start) / 1000),
      heapBytes: memory.usedSize,
      modelReads: [...reads.values()].reduce((a, b) => a + b, 0),
    })
    assert.deepEqual(faults, [])
    await save()
    sample++
    if ((Date.now() - start) / 1000 >= duration) break
    await page.waitForTimeout(Math.min(30_000, duration * 1000 - (Date.now() - start)))
    // Duration is checked after recording a sample inside this loop.
    // eslint-disable-next-line no-constant-condition
  } while (true)
  report.status = 'passed'
  report.elapsedSoakSeconds = (Date.now() - start) / 1000
  report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.status = 'failed'
  report.error = String(error)
  await save()
  throw error
} finally {
  await browser.close()
  await vite.close()
  await backend.close()
  await rm(dir, { recursive: true, force: true })
}
