import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { openPptx, materializeSlide, duplicateSlide, savePptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../../parse-server/src/server.ts'
import { root } from './paths.mjs'
import { createAndroidTestDevice } from './android-test-device.mjs'

const duration = Number(process.env.SOAK_SECONDS || '0')
assert.ok(Number.isFinite(duration) && duration >= 0)
const output = process.env.RESILIENCE_REPORT || '/tmp/genoffice-android-offline-resilience.json'
const dir = await mkdtemp(join(tmpdir(), 'android-viewer-offline-'))
const backend = await createParseServer({ dataDir: dir })
const debugPort = process.env.ANDROID_DEBUG_PORT || '9223'
const device = createAndroidTestDevice([backend.url], Number(debugPort))
const adb = async (...args: string[]) => device.adb(...args).trim()
let backendClosed = false
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined
const report: any = {
  status: 'running',
  startedAt: new Date().toISOString(),
  requestedSoakSeconds: duration,
  samples: [],
}
const save = () => writeFile(output, JSON.stringify(report, null, 2))
try {
  const deck = await openPptx(
    new Uint8Array(
      await readFile(
        resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
      ),
    ),
  )
  for (let index = 0; index < deck.deck.slides.length; index++) materializeSlide(deck, index)
  while (deck.deck.slides.length < 50)
    assert.ok(duplicateSlide(deck, Math.floor(deck.deck.slides.length / 2)))
  const uploaded = await fetch(`${backend.url}/v1/files`, {
    method: 'POST',
    body: Buffer.from(await savePptx(deck)),
  })
  assert.equal(uploaded.status, 201)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  report.fileId = fileId
  await save()
  device.access()
  await adb('shell', 'am', 'force-stop', 'com.genoffice.viewerdemo')
  await adb(
    'shell',
    'am',
    'start',
    '-n',
    'com.genoffice.viewerdemo/.MainActivity',
    '--es',
    'server',
    backend.url,
    '--es',
    'fileId',
    fileId,
    '--es',
    'token',
    'offline-test',
    '--ez',
    'download',
    'true',
  )
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && !browser) {
    try {
      const pid = await adb('shell', 'pidof', 'com.genoffice.viewerdemo')
      await adb('forward', `tcp:${debugPort}`, `localabstract:webview_devtools_remote_${pid}`)
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
        timeout: 2000,
        noDefaults: true,
      })
    } catch {
      await new Promise((done) => setTimeout(done, 1000))
    }
  }
  assert.ok(browser, 'Android WebView debugger must become available')
  await expect
    .poll(
      () =>
        browser!
          .contexts()
          .flatMap((context) => context.pages())
          .some((page) => page.url().includes(`fileId=${fileId}`)),
      { timeout: 60_000 },
    )
    .toBe(true)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes(`fileId=${fileId}`))!
  assert.ok(page, 'WebView must contain the downloaded document')
  await expect(page.getByLabel('开始放映')).toBeVisible({ timeout: 90_000 })
  await backend.close()
  backendClosed = true
  device.disconnect()
  const faults: string[] = []
  page.on('pageerror', (e) => faults.push(e.message))
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1')
      faults.push(`external request ${request.url()}`)
  })
  const localOrigin = new URL(page.url()).origin
  const compatibilityResponses: Record<string, number> = {}
  let replaySessions = 0
  page.on('response', (response) => {
    const url = new URL(response.url())
    const method = response.request().method()
    const status = response.status()
    if (
      url.origin === localOrigin &&
      method === 'POST' &&
      url.pathname === '/v1/sessions' &&
      status < 300
    )
      replaySessions++
    if (status < 400) return
    const key = `${method} ${url.pathname} ${status}`
    // The local v1 replay server intentionally rejects v2 discovery and heartbeat.
    if (
      url.origin === localOrigin &&
      [
        'GET /v2/capabilities 404',
        'POST /v2/sessions 405',
        'POST /v2/sessions/local/heartbeat 405',
      ].includes(key)
    )
      compatibilityResponses[key] = (compatibilityResponses[key] ?? 0) + 1
    else faults.push(`${status} ${response.url()}`)
  })
  // Reopen all model/font/image requests with the parse service shut down.
  await page.reload()
  await expect(page.getByLabel('开始放映')).toBeVisible({ timeout: 60_000 })
  await page.getByLabel('开始放映').click()
  await expect(page.locator('.slideshow')).toBeVisible()
  const jump = async (number: number) => {
    await page.evaluate((number) => {
      for (const key of [...('0000' + number), 'Enter'])
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }, number)
    await expect(page.locator('.ss-counter')).toHaveText(new RegExp(`^\\s*${number}\\s*/`))
  }
  for (let index = 0; index < 40; index++) await jump(1 + ((index * 7) % 50))
  await page.waitForTimeout(2000)
  assert.deepEqual(faults, [])
  assert.ok(replaySessions > 0, 'offline reload must open a real local v1 replay session')
  report.compatibilityResponses = compatibilityResponses
  report.offlineReload = 'passed'
  report.rapidJumps = 40
  const cdp = await page.context().newCDPSession(page)
  const start = Date.now()
  let index = 0
  let baseline: number | undefined
  let lastSampleAt = Date.now()
  do {
    assert.ok(Date.now() - lastSampleAt < 90_000, 'continuous run interrupted for over 90 seconds')
    lastSampleAt = Date.now()
    await jump(1 + ((index * 7) % 50))
    await cdp.send('HeapProfiler.collectGarbage')
    const memory = await cdp.send('Runtime.getHeapUsage')
    if (index === 5) baseline = memory.usedSize
    if (baseline !== undefined)
      assert.ok(memory.usedSize < baseline + 64 * 1024 * 1024, 'retained JS heap grew over 64 MiB')
    const meminfo = await adb('shell', 'dumpsys', 'meminfo', 'com.genoffice.viewerdemo')
    const pssKiB = Number(/TOTAL PSS:\s+(\d+)/.exec(meminfo)?.[1])
    report.samples.push({
      mainProcessPssKiB: Number.isFinite(pssKiB) ? pssKiB : null,
      elapsedSeconds: (Date.now() - start) / 1000,
      heapBytes: memory.usedSize,
    })
    assert.deepEqual(faults, [])
    await save()
    index++
    if ((Date.now() - start) / 1000 >= duration) break
    await page.waitForTimeout(Math.min(30_000, duration * 1000 - (Date.now() - start)))
  } while ((Date.now() - start) / 1000 < duration)
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
  device.restore()
  await browser?.close()
  if (!backendClosed) await backend.close()
  await rm(dir, { recursive: true, force: true })
}
