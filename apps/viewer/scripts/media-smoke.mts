import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium, type Browser } from 'playwright-core'
import type { Server } from 'node:http'
import { mediaFixture } from '../tests/media-fixture'
const app = new URL('../', import.meta.url).pathname
const dir = await mkdtemp(join(tmpdir(), 'viewer-media-test-'))
process.env.VIEWER_DATA_DIR = dir
const entry = new URL('../dist/server/index.mjs', import.meta.url).href
const { createViewerServer } = await import(entry)
const server: Server = await createViewerServer()
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address !== 'string')
const url = `http://127.0.0.1:${address.port}`
let browser: Browser | undefined
try {
  const fixture = await mediaFixture()
  const output = resolve(app, 'test-results')
  await mkdir(output, { recursive: true })
  const path = resolve(output, 'media.pptx')
  await writeFile(path, fixture.deck)
  browser = await chromium.launch({
    executablePath:
      process.env.VIEWER_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(url)
  await page.waitForFunction(
    () => !document.querySelector<HTMLInputElement>('input[type=file]')!.disabled,
  )
  await page.getByLabel('打开文件').setInputFiles(path)
  await page.locator('iframe').waitFor()
  const frame = await (await page.locator('iframe').elementHandle())!.contentFrame()
  assert.ok(frame)
  await frame.getByRole('button', { name: '播放视频', exact: true }).first().waitFor()
  await frame.getByRole('button', { name: '播放视频', exact: true }).first().click()
  await frame.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('.viewer-slide-stage video')
    return video && !video.paused && video.currentTime > 0.15 && video.videoWidth === 160
  })
  await page.screenshot({ path: resolve(output, 'media-playing.png') })
  const mediaURL = await frame.locator('video').getAttribute('src')
  assert.ok(mediaURL)
  const partial = await page.request.get(url + mediaURL, { headers: { Range: 'bytes=0-7' } })
  assert.equal(partial.status(), 206)
  assert.equal(partial.headers()['content-type'], 'video/webm')
  assert.deepEqual(await partial.body(), fixture.video.subarray(0, 8))
  const previewVideo = await frame.locator('video').elementHandle()
  await frame.locator('video').focus()
  await page.keyboard.press('Escape')
  await frame.locator('video').waitFor({ state: 'detached' })
  assert.equal(
    await previewVideo!.evaluate((element) => (element as HTMLMediaElement).paused),
    true,
  )
  await frame.getByRole('button', { name: '播放音频', exact: true }).click()
  await frame.waitForFunction(() => {
    const audio = document.querySelector<HTMLAudioElement>('.viewer-slide-stage audio')
    return audio && !audio.paused && audio.currentTime > 0.15
  })
  const previewAudio = await frame.locator('audio').elementHandle()
  await frame.getByRole('button', { name: '下一页', exact: true }).click()
  await frame.locator('audio').waitFor({ state: 'detached' })
  assert.equal(
    await previewAudio!.evaluate((element) => (element as HTMLMediaElement).paused),
    true,
  )
  await frame.getByRole('button', { name: '上一页', exact: true }).click()
  await frame.getByRole('button', { name: '播放视频', exact: true }).nth(1).click()
  await frame.getByRole('alert').filter({ hasText: '无法播放该媒体' }).waitFor()
  await frame.getByRole('button', { name: '关闭媒体播放' }).click()
  await frame.getByRole('button', { name: '开始放映', exact: true }).click()
  await frame.locator('.slideshow video').first().waitFor()
  await frame.locator('.slideshow video').first().click()
  await frame.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('.slideshow video')
    return video && !video.paused && video.currentTime > 0.15
  })
  const showVideo = await frame.locator('.slideshow video').first().elementHandle()
  await page.keyboard.press('ArrowRight')
  await frame.locator('.slideshow video').waitFor({ state: 'detached' })
  assert.equal(await showVideo!.evaluate((element) => (element as HTMLMediaElement).paused), true)
  await page.keyboard.press('Escape')
  await frame.locator('.slideshow').waitFor({ state: 'detached' })
  assert.deepEqual(pageErrors, [])
  console.log(
    'Media passed: preview video/audio decoding and advancing clocks; Range stream; Escape/page teardown; broken media feedback; slideshow playback',
  )
} finally {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(dir, { recursive: true, force: true })
}
