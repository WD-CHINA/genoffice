/** Browser evidence for a local corpus-drill JSON; source documents stay outside the repository. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}
if (!option('corpus')) throw new Error('--corpus is required')
const corpus = JSON.parse(await readFile(resolve(option('corpus')), 'utf8')) as any
const output = resolve(option('out', '/tmp/genoffice-corpus-browser'))
const token = process.env.PARSE_SERVER_TOKEN ?? ''
const serverUrl = option('server', corpus.base)
process.env.PARSE_SERVER_URL = serverUrl
await mkdir(output, { recursive: true })
const frontend = await createServer({ configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: { host: '127.0.0.1', port: 11019, strictPort: true } })
await frontend.listen()
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) })
const report: any = { startedAt: new Date().toISOString(), status: 'running', samples: [],
  scope: 'Representative business pages; optional playback smoke; no independent Office visual baseline' }
try {
  for (const document of corpus.documents.filter((item: any) => item.status === 'passed')) {
    if (option('only-name') && document.name !== option('only-name')) continue
    const indices: number[] = document.format === 'pptx'
      ? [...new Set([0, Math.floor(document.unitCount / 2), document.unitCount - 1])] : [0]
    for (const index of indices) {
      if (option('only-index') && index !== Number(option('only-index'))) continue
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
      await context.addInitScript(({ fileId, page }) => {
        localStorage.setItem('genoffice.reading-position.v1', JSON.stringify({
          [fileId]: { page, savedAt: Date.now() },
        }))
      }, { fileId: document.fileId, page: index })
      const page = await context.newPage()
      const sample: any = { name: document.name, format: document.format, index, errors: [], httpErrors: [] }
      report.samples.push(sample)
      page.on('pageerror', (error) => sample.errors.push(error.message))
      page.on('response', (response) => {
        if (response.status() >= 400) sample.httpErrors.push({ status: response.status(), path: new URL(response.url()).pathname })
      })
      try {
        const params = new URLSearchParams({ parse: 'server', server: serverUrl, fileId: document.fileId,
          name: document.name, ...(token ? { token } : {}) })
        await page.goto(`http://127.0.0.1:11019/?${params}`)
        const frame = page.frameLocator('iframe')
        if (document.format === 'docx') {
          await frame.locator('.viewer-doc-remote-page').first().waitFor({ timeout: 60_000 })
        } else {
          await frame.locator('canvas').first().waitFor({ timeout: 60_000 })
        }
        const contentFrame = page.frames().find((value) => value.url().includes('preview.html'))!
        await contentFrame.evaluate(async () => { await document.fonts.ready })
        if (document.format === 'pptx') {
          await contentFrame.waitForFunction(() => Boolean((window as any).__viewerPerformance?.stages?.currentPageImagesReady), undefined, { timeout: 60_000 })
        }
        await page.waitForTimeout(1000)
        sample.screenshot = `${document.fileId.slice(0, 12)}-${index}.png`
        await page.screenshot({ path: join(output, sample.screenshot) })
        sample.metrics = await contentFrame.evaluate(() => ({
          canvasCount: document.querySelectorAll('canvas').length,
          pages: document.querySelectorAll('.viewer-doc-remote-page').length,
          fontCount: document.fonts.size,
          fontErrors: [...document.fonts].filter((font) => font.status === 'error').map((font) => font.family),
          alerts: [...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent),
          performance: (window as any).__viewerPerformance,
        }))
        if (document.format !== 'docx') {
          // Screenshots work for legitimate cross-origin images too; reading
          // canvas pixels in page JS would reject tainted canvases.
          const canvasIndex = await contentFrame.locator('canvas').evaluateAll((elements) =>
            elements.reduce((largest, element, index) =>
              (element as HTMLCanvasElement).width * (element as HTMLCanvasElement).height >
              (elements[largest] as HTMLCanvasElement).width * (elements[largest] as HTMLCanvasElement).height
                ? index : largest, 0))
          const pixels = await contentFrame.locator('canvas').nth(canvasIndex).screenshot()
          sample.pixelHash = createHash('sha256').update(pixels).digest('hex')
        }
        assert.equal(sample.errors.length, 0, sample.errors.join('\n'))
        assert.equal(sample.metrics.fontErrors.length, 0, 'font loading failures')
        sample.fontFallbackWarnings = sample.metrics.alerts.filter((text: string) => text?.startsWith('以下字体未包含在字体包中'))
        assert.equal(sample.metrics.alerts.filter((text: string) => text && !text.startsWith('以下字体未包含在字体包中')).length, 0, 'document error alert')
        sample.status = sample.fontFallbackWarnings.length ? 'passed_with_warnings' : 'passed'
        if (process.argv.includes('--playback') && document.format === 'pptx') {
          await frame.getByRole('button', { name: '开始放映', exact: true }).click()
          await page.waitForTimeout(1000)
          await contentFrame.locator('body').press('ArrowRight')
          await page.waitForTimeout(2500)
          sample.playbackScreenshot = `${document.fileId.slice(0, 12)}-${index}-playback.png`
          await page.screenshot({ path: join(output, sample.playbackScreenshot) })
          await contentFrame.locator('body').press('Escape')
          await frame.getByRole('button', { name: '开始放映', exact: true }).waitFor()
          assert.equal(sample.errors.length, 0, sample.errors.join('\n'))
          sample.playback = 'entered, advanced with keyboard, exited; animation timing not reference-verified'
        }
      } catch (error) {
        sample.status = 'failed'; sample.error = String(error)
        await page.screenshot({ path: join(output, `${document.fileId.slice(0, 12)}-${index}-failed.png`) }).catch(() => undefined)
      } finally {
        console.log(JSON.stringify({ name: document.name, index, status: sample.status, error: sample.error }))
        await context.close()
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
      }
    }
  }
  report.status = report.samples.some((sample: any) => sample.status === 'failed') ? 'failed'
    : report.samples.some((sample: any) => sample.status === 'passed_with_warnings') ? 'passed_with_warnings' : 'passed'
  if (report.status === 'failed') process.exitCode = 1
} finally {
  report.completedAt = new Date().toISOString()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2))
  await browser.close()
  await frontend.close()
}
