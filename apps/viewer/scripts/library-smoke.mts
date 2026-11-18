import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from '@playwright/test'
import { createServer } from 'vite'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../../parse-server/src/server'

const directory = await mkdtemp(join(tmpdir(), 'library-browser-'))
const token = 'isolated-library-test'
let parser = await createParseServer({ dataDir: directory, token })
process.env.PARSE_SERVER_URL = parser.url
process.env.VIEWER_BASE = '/viewer/'
const frontend = await createServer({
  configFile: resolve(import.meta.dirname, '../vite.config.ts'),
  server: { host: '127.0.0.1', port: 0, strictPort: false },
})
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  await frontend.listen()
  const port = (frontend.httpServer!.address() as { port: number }).port
  const origin = `http://127.0.0.1:${port}`
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.CHROME_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}/viewer/upload.html?token=${token}`)
  const history = page.getByRole('region', { name: '历史资源', exact: true })
  await expect(history.getByText('暂无已保存的资源')).toBeVisible()
  await page.locator('input[type=file]').setInputFiles({
    name: 'persisted-deck.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: Buffer.from(await createBlankPptx()),
  })
  await expect(page.getByText('上传成功', { exact: true })).toBeVisible()
  let failSave = true
  await page.route('**/v1/library*', (route) => {
    if (route.request().method() === 'POST' && failSave) {
      failSave = false
      return route.fulfill({
        status: 507,
        contentType: 'application/json',
        body: JSON.stringify({ message: '测试容量不足' }),
      })
    }
    return route.continue()
  })
  await page.getByRole('button', { name: '保存到历史资源', exact: true }).click()
  await expect(page.getByText('保存历史资源失败：测试容量不足')).toBeVisible()
  await expect(history.getByText('暂无已保存的资源')).toBeVisible()
  await page.getByRole('button', { name: '保存到历史资源', exact: true }).click()
  await expect(history.getByText('persisted-deck.pptx', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '已保存到历史资源', exact: true })).toBeDisabled()

  const open = async () => {
    const opened = page.waitForEvent('popup')
    await history.getByRole('link', { name: '打开', exact: true }).click()
    const popup = await opened
    // A preview canvas can appear before publication; restart reuse requires a ready artifact.
    const ready = popup.waitForResponse(async (response) => {
      if (!/^\/v1\/sessions(?:\/[^/]+)?$/.test(new URL(response.url()).pathname) || !response.ok())
        return false
      try {
        return (await response.json()).state === 'ready'
      } catch {
        return false
      }
    })
    await expect(popup.locator('.viewer-slide-stage canvas').first()).toBeVisible({
      timeout: 30_000,
    })
    await ready
    assert.equal(new URL(popup.url()).pathname, '/viewer/preview.html')
    assert.equal(await popup.locator('iframe').count(), 0)
    const params = new URL(popup.url()).searchParams
    for (const key of [
      'parse',
      'src',
      'format',
      'contentUrl',
      'layout',
      'showHeader',
      'showToolbar',
    ])
      assert.equal(params.has(key), false, `preview URL must omit ${key}`)
    assert.equal(params.has('server'), false, 'same-origin server must be inferred')
    await popup.close()
  }
  await open()
  const originalPort = parser.port
  await parser.close()
  parser = await createParseServer({ dataDir: directory, token, port: originalPort })
  await page.reload()
  await expect(history.getByText('persisted-deck.pptx', { exact: true })).toBeVisible()
  await open()
  const health = (await (await fetch(`${parser.url}/v1/health`)).json()) as {
    artifacts: { buildsStarted: number }
  }
  assert.equal(
    health.artifacts.buildsStarted,
    0,
    'reopening saved history after restart must not parse again',
  )
  await history.getByRole('button', { name: '从历史资源移除' }).click()
  await expect(history.getByText('暂无已保存的资源')).toBeVisible()
  assert.deepEqual(errors, [])
  const output = process.env.VIEWER_LIBRARY_SCREENSHOTS || '/tmp/genoffice-library-ui'
  await mkdir(output, { recursive: true })
  await page.screenshot({ path: join(output, 'library-flow.png'), fullPage: true })
  // Large container + 1201 paragraphs exercises remote chunks without downloading the original.
  const word = await JSZip.loadAsync(
    await readFile(
      resolve(import.meta.dirname, '../../parse-server/tests/fixtures/docx/table.docx'),
    ),
  )
  const sourceDocument = await word.file('word/document.xml')!.async('string')
  const paragraphs = Array.from(
    { length: 1201 },
    (_, index) => `<w:p><w:r><w:t>Cache paragraph ${index}</w:t></w:r></w:p>`,
  ).join('')
  word.file('word/document.xml', sourceDocument.replace(/(<w:body[^>]*>)/, `$1${paragraphs}`))
  const fontFixture = await JSZip.loadAsync(
    await readFile(
      resolve(import.meta.dirname, '../../parse-server/tests/fixtures/docx/font.docx'),
    ),
  )
  for (const path of [
    'word/fontTable.xml',
    'word/_rels/fontTable.xml.rels',
    'word/fonts/font1.odttf',
  ]) {
    const entry = fontFixture.file(path)!
    word.file(
      path,
      path.endsWith('fontTable.xml')
        ? (await entry.async('string')).replace(
            'w:name="Carlito"',
            'w:name="GenofficeLifecycleProbe"',
          )
        : await entry.async('nodebuffer'),
    )
  }
  word.file(
    '[Content_Types].xml',
    (await word.file('[Content_Types].xml')!.async('string')).replace(
      '</Types>',
      '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
        '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>',
    ),
  )
  word.file(
    'word/_rels/document.xml.rels',
    (await word.file('word/_rels/document.xml.rels')!.async('string')).replace(
      '</Relationships>',
      '<Relationship Id="rIdScopeFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>',
    ),
  )
  word.file('word/media/unused-padding.bin', Buffer.alloc(65 * 1024 * 1024), {
    compression: 'STORE',
  })
  const uploadedWord = await fetch(`${parser.url}/v1/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: await word.generateAsync({ type: 'nodebuffer', compression: 'STORE' }),
  })
  assert.equal(uploadedWord.status, 201)
  const wordFile = (await uploadedWord.json()) as { fileId: string; size: number }
  assert.ok(wordFile.size > 64 * 1024 * 1024)
  const wordHealth = async () =>
    (
      await fetch(`${parser.url}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json() as Promise<{ artifacts: { buildsStarted: number } }>
  const beforeWord = await wordHealth()
  let expiredWord = false
  await page.route('**/v1/sessions/*/units?*', async (route) => {
    if (expiredWord) return route.continue()
    expiredWord = true
    const id = new URL(route.request().url()).pathname.split('/')[3]
    const deleted = await fetch(`${parser.url}/v1/sessions/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    assert.equal(deleted.status, 204)
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })
  // Word now reads all source chunks into the original page layout. Viewport
  // eviction/load-more expectations belonged to the retired continuous reader.
  const wordRequests: string[] = []
  page.on('request', (request) => wordRequests.push(request.url()))
  await page.goto(
    `${origin}/viewer/preview.html?${new URLSearchParams({ fileId: wordFile.fileId, token, name: 'async-word.docx', view: 'read' })}`,
  )
  await expect(page.locator('.pv-page .pv-content').first()).toBeVisible({ timeout: 120_000 })
  const viewport = page.locator('.pv-scroll')
  const visibleParagraph = (text: string) =>
    page.locator('.viewer-doc-pages').evaluate(
      (root, text) =>
        [...root.querySelectorAll('p[data-idx]')].some((node) => {
          if (node.textContent !== text) return false
          const rect = node.getBoundingClientRect()
          let top = rect.top,
            bottom = rect.bottom
          for (
            let parent = node.parentElement;
            parent && parent !== root;
            parent = parent.parentElement
          )
            if (parent.matches('.pv-clip,.pv-region,.pv-page,.pv-scroll')) {
              const clip = parent.getBoundingClientRect()
              top = Math.max(top, clip.top)
              bottom = Math.min(bottom, clip.bottom)
            }
          return bottom > top && rect.width > 0
        }),
      text,
    )
  await expect.poll(() => visibleParagraph('Cache paragraph 0')).toBe(true)
  await expect(
    page.locator('[contenteditable="true"],.viewer-doc-reading-paper,[aria-label="Word 显示模式"]'),
  ).toHaveCount(0)
  const sheetCount = await page.locator('.pv-page').count()
  assert.ok(sheetCount > 1)
  const readsBeforeScroll = wordRequests.filter((url) => /\/units\//.test(url)).length
  const cdp = await page.context().newCDPSession(page)
  const samples = []
  for (let cycle = 0; cycle < 4; cycle++) {
    await viewport.evaluate((element) => {
      const debug = (window as any).__previewDebug
      const block = debug.blocks.find((b: any) => b.idx === '1200')
      const index = debug.slices.findIndex((s: any) => block.top >= s.start && block.top < s.end)
      const sheet = element.querySelector(`[data-pv-page="${index}"]`)!
      element.scrollTop += sheet.getBoundingClientRect().top - element.getBoundingClientRect().top
    })
    await expect
      .poll(() => visibleParagraph('Cache paragraph 1200'), { timeout: 30_000 })
      .toBe(true)
    await viewport.evaluate((element) => {
      element.scrollTop = 0
    })
    await expect.poll(() => visibleParagraph('Cache paragraph 0')).toBe(true)
    await cdp.send('HeapProfiler.collectGarbage')
    samples.push({
      cycle,
      heap: await cdp.send('Runtime.getHeapUsage'),
      dom: await cdp.send('Memory.getDOMCounters'),
    })
    assert.equal(await page.locator('.pv-page').count(), sheetCount)
  }
  await cdp.detach()
  assert.equal(
    wordRequests.filter((url) => /\/units\//.test(url)).length,
    readsBeforeScroll,
    'Scrolling must use the loaded model, not the retired chunk viewport',
  )
  assert.equal(
    wordRequests.some((url) => url.endsWith('/content')),
    false,
    'HTTP Word must not download the original for local reparsing',
  )
  assert.equal(expiredWord, true)
  assert.equal(
    (await wordHealth()).artifacts.buildsStarted - beforeWord.artifacts.buildsStarted,
    1,
    'Expired DOCX session must reuse the artifact',
  )
  await writeFile(join(output, 'docx-memory-samples.json'), JSON.stringify(samples, null, 2))
  await page.screenshot({ path: join(output, 'async-docx-pages.png') })
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      ok: true,
      failedSaveRetried: true,
      restartCacheHit: true,
      removedFromHistory: true,
      wordDefaultPages: true,
      wordReadOnly: true,
      expiredDocxRecoveredWithoutReparse: true,
      wordTailReached: true,
      sheetCount,
      memoryReport: join(output, 'docx-memory-samples.json'),
    }),
  )
} catch (error) {
  const failed = browser?.contexts()[0]?.pages()[0]
  if (failed) {
    await failed.screenshot({ path: '/tmp/genoffice-library-failure.png' }).catch(() => {})
    await writeFile(
      '/tmp/genoffice-library-failure.json',
      JSON.stringify(
        await failed.evaluate(() => ({
          scroll: document.querySelector('.pv-scroll')?.scrollTop,
          pages: [...document.querySelectorAll('.pv-page')].map((e) => ({
            box: e.getBoundingClientRect().toJSON(),
            children: e.children.length,
          })),
          tail: [...document.querySelectorAll('p[data-idx="1200"]')].map((e) => ({
            box: e.getBoundingClientRect().toJSON(),
            parent: e.parentElement?.className,
            clips: [...(e.closest('.pv-page')?.querySelectorAll('.pv-clip') ?? [])].map((c) =>
              c.getBoundingClientRect().toJSON(),
            ),
          })),
        })),
        null,
        2,
      ),
    )
  }
  throw error
} finally {
  await browser?.close()
  await frontend.close()
  await parser.close().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
