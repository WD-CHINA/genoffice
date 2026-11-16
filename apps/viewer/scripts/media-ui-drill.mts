/** Small-deck auto routing, visible preparation states and retry against the real server. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'
import JSZip from 'jszip'
const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf('--' + name)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
assert.ok(option('input'), '--input requires a synthetic WMV PPTX')
const out = resolve(option('out', '/tmp/genoffice-media-production/ui'))
const base = option('server', 'http://127.0.0.1:18787')
const token = process.env.PARSE_SERVER_TOKEN ?? ''
process.env.PARSE_SERVER_URL = base
await mkdir(out, { recursive: true })
const broken = await JSZip.loadAsync(await readFile(option('input')))
broken.file('ppt/media/sample.wmv', 'invalid media content')
const invalid = join(out, 'invalid-media.pptx')
await writeFile(invalid, await broken.generateAsync({ type: 'nodebuffer' }))
const frontend = await createServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VIEWER_TEST_PORT || 11019),
    strictPort: true,
  },
})
await frontend.listen()
const viewerOrigin = `http://127.0.0.1:${(frontend.httpServer!.address() as { port: number }).port}`
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const report: any = { browser: browser.version(), cases: [] }
const business = option('business-report')
  ? JSON.parse(await readFile(option('business-report'), 'utf8')).documents.find((d: any) =>
      d.name.startsWith('47e66'),
    )
  : undefined
try {
  // Warm Vite's lazy dependency optimizer before a file-input case. A dev-only
  // optimizer reload would otherwise discard the in-memory selected File.
  const upload = await fetch(base + '/v1/files', {
    method: 'POST',
    body: await readFile(option('input')),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  assert.ok(upload.ok)
  const { fileId } = (await upload.json()) as { fileId: string }
  const warm = await browser.newPage()
  await warm.goto(
    viewerOrigin +
      '/?' +
      new URLSearchParams({
        parse: 'server',
        server: base,
        fileId,
        name: 'warmup.pptx',
        ...(token ? { token } : {}),
      }),
  )
  await warm.frameLocator('iframe').locator('canvas').first().waitFor({ timeout: 90_000 })
  await warm.waitForTimeout(2000)
  await warm.close()
  if (business) {
    // A repeated run must not hit the previous force-conversion result: append
    // a legal MP4 free atom in a private PPTX variant, keeping the source intact.
    const inventory = JSON.parse(
      await readFile(join(dirname(option('business-report')), 'transcode.json'), 'utf8'),
    )
    const original = inventory.documents.find((d: any) => d.name === business.name)
    const variant = await JSZip.loadAsync(await readFile(original.source))
    const part = 'ppt/media/media1.mp4'
    const video = await variant.file(part)!.async('nodebuffer')
    const free = Buffer.alloc(44)
    free.writeUInt32BE(free.length)
    free.write('free', 4)
    free.write(randomUUID(), 8)
    variant.file(part, Buffer.concat([video, free]))
    const uploaded = await fetch(base + '/v1/files', {
      method: 'POST',
      body: await variant.generateAsync({ type: 'arraybuffer', compression: 'STORE' }),
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    assert.ok(uploaded.ok)
    business.fileId = ((await uploaded.json()) as { fileId: string }).fileId
  }
  for (const [name, path] of [
    ['auto-small-wmv', option('input')],
    ['invalid-and-retry', invalid],
    ...(business ? [['force-conversion-progress', '']] : []),
  ]) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
    await context.addInitScript('globalThis.__name=(fn)=>fn')
    if (name === 'force-conversion-progress')
      await context.addInitScript(
        ({ fileId, page }) => {
          localStorage.setItem(
            'genoffice.reading-position.v1',
            JSON.stringify({ [fileId]: { page, savedAt: Date.now() } }),
          )
        },
        { fileId: business.fileId, page: business.units[0].index },
      )
    const page = await context.newPage()
    const sample: any = { name, requests: [], errors: [] }
    report.cases.push(sample)
    page.on('pageerror', (error) => sample.errors.push(error.message))
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        /\/v[12]\/files(?:$|\/)/.test(new URL(request.url()).pathname)
      )
        sample.requests.push({
          path: new URL(request.url()).pathname,
          body: new URL(request.url()).pathname.endsWith('/media')
            ? request.postDataJSON()
            : undefined,
        })
    })
    try {
      await page.goto(
        viewerOrigin +
          '/?' +
          new URLSearchParams({
            parse: name === 'force-conversion-progress' ? 'server' : 'auto',
            server: base,
            ...(name === 'force-conversion-progress'
              ? { fileId: business.fileId, name: business.name }
              : {}),
            ...(token ? { token } : {}),
          }),
      )
      if (name !== 'force-conversion-progress')
        await page.locator('input[type=file]').first().setInputFiles(path)
      const frame = page.frameLocator('iframe')
      const play = frame.getByRole('button', { name: '播放视频', exact: true }).first()
      await play.waitFor({ timeout: 90_000 })
      const content = page.frames().find((f) => f.url().includes('preview.html'))!
      await content.evaluate(() => {
        ;(window as any).__mediaStatuses = []
        new MutationObserver(() => {
          for (const el of document.querySelectorAll('[role="status"]')) {
            const text = el.textContent ?? ''
            if (text.includes('媒体')) (window as any).__mediaStatuses.push(text)
          }
        }).observe(document.body, { childList: true, subtree: true, characterData: true })
      })
      await play.click()
      if (name === 'invalid-and-retry') {
        const retry = frame.getByRole('button', { name: '重试媒体', exact: true })
        await retry.waitFor({ timeout: 30_000 })
        sample.failureText = await frame.locator('[role=alert]').last().textContent()
        await retry.click()
        await page.waitForFunction(() => true)
        await retry.waitFor({ timeout: 30_000 })
        assert.ok(
          sample.requests.some((r: any) => r.body?.retry === true),
          'retry did not reach preparation API',
        )
      } else {
        const media = frame.locator('video').first()
        await media.waitFor({ timeout: 30_000 })
        if (name === 'force-conversion-progress') {
          // Controlled decoder-error event tests the retry/normalization UI;
          // this business video is otherwise compatible and plays normally.
          await media.evaluate((element: HTMLMediaElement) => {
            element.pause()
            element.dispatchEvent(new Event('error'))
          })
          await frame.getByRole('button', { name: '重试媒体', exact: true }).click()
          await content.waitForFunction(
            () =>
              (window as any).__mediaStatuses.some((text: string) => text.includes('正在转换媒体')),
            undefined,
            { timeout: 30_000 },
          )
          await media.waitFor({ timeout: 60_000 })
          sample.injectedDecodeError = true
        }
        await media.evaluate((element: HTMLMediaElement) => {
          element.muted = true
          return element.play()
        })
        await page.waitForTimeout(500)
        sample.playback = await media.evaluate((element: HTMLMediaElement) => ({
          url: element.currentSrc,
          time: element.currentTime,
          duration: element.duration,
          error: element.error?.code,
        }))
        assert.ok(
          sample.playback.url.includes('/media/') &&
            sample.playback.time > 0 &&
            !sample.playback.error,
        )
        sample.playback.url = new URL(sample.playback.url).pathname
      }
      sample.statuses = [...new Set(await content.evaluate(() => (window as any).__mediaStatuses))]
      assert.ok(sample.statuses.length, 'no visible preparation state')
      if (name !== 'force-conversion-progress')
        assert.ok(
          sample.requests.some((r: any) => /\/v[12]\/files$/.test(r.path)),
          'auto mode did not upload the small media deck',
        )
      assert.equal(sample.errors.length, 0)
      await page.screenshot({ path: join(out, `${name}.png`) })
      sample.status = 'passed'
    } catch (error) {
      sample.status = 'failed'
      sample.error = String(error)
      await page.screenshot({ path: join(out, `${name}-failed.png`) }).catch(() => undefined)
    }
    await context.close()
    await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(sample))
  }
  assert.ok(report.cases.every((item: any) => item.status === 'passed'))
} finally {
  await browser.close()
  await frontend.close()
}
