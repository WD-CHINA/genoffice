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
  server: { host: '127.0.0.1', port: 0 },
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
  await page.route('**/v2/library*', (route) => {
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
    await expect(
      popup.frameLocator('iframe').locator('.viewer-slide-stage canvas').first(),
    ).toBeVisible({ timeout: 30_000 })
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
  const paragraphs = Array.from({ length: 1201 }, (_, index) =>
    `<w:p><w:r><w:t>Cache paragraph ${index}</w:t></w:r></w:p>`,
  ).join('')
  word.file('word/document.xml', sourceDocument.replace(/(<w:body[^>]*>)/, `$1${paragraphs}`))
  const fontFixture = await JSZip.loadAsync(await readFile(
    resolve(import.meta.dirname, '../../parse-server/tests/fixtures/docx/font.docx'),
  ))
  for (const path of ['word/fontTable.xml', 'word/_rels/fontTable.xml.rels', 'word/fonts/font1.odttf']) {
    const entry = fontFixture.file(path)!
    word.file(path, path.endsWith('fontTable.xml')
      ? (await entry.async('string')).replace('w:name="Carlito"', 'w:name="GenofficeLifecycleProbe"')
      : await entry.async('nodebuffer'))
  }
  word.file('[Content_Types].xml', (await word.file('[Content_Types].xml')!.async('string')).replace('</Types>',
    '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>' +
    '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/></Types>'))
  word.file('word/_rels/document.xml.rels', (await word.file('word/_rels/document.xml.rels')!.async('string')).replace('</Relationships>',
    '<Relationship Id="rIdScopeFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/></Relationships>'))
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
  const wordRequests: string[] = []
  let firstUnitReads = 0
  let expireOnReturn = false
  let expiredOnReturn = false
  let failedOnReturn = false
  let delayNextFirstUnit = false
  let delayedUnitStarted = false
  let releaseDelayedUnit!: () => void
  const delayedUnitGate = new Promise<void>((resolve) => { releaseDelayedUnit = resolve })
  await page.route('**/v1/sessions/*/units/0', async (route) => {
    firstUnitReads++
    if (expireOnReturn && !expiredOnReturn) {
      expiredOnReturn = true
      const id = new URL(route.request().url()).pathname.split('/')[3]
      const deleted = await fetch(`${parser.url}/v1/sessions/${id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      })
      assert.equal(deleted.status, 204)
      return route.fulfill({ status: 410, contentType: 'application/json', body: '{}' })
    }
    if (expiredOnReturn && !failedOnReturn) {
      failedOnReturn = true
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
    }
    const response = await route.fetch()
    const unit = await response.json()
    if (delayNextFirstUnit) {
      delayNextFirstUnit = false
      delayedUnitStarted = true
      await delayedUnitGate
      try {
        await route.fulfill({ response, json: unit })
      } catch (error) {
        if (!route.request().failure()?.errorText.includes('ERR_ABORTED')) throw error
      }
      return
    }
    // Force an oversized unit past the retained-cache budget without huge rendered text.
    await route.fulfill({ response, json: { ...unit, cachePadding: 'x'.repeat(5 * 1024 * 1024) } })
  })
  page.on('request', (request) => wordRequests.push(request.url()))
  await page.goto(
    `${origin}/viewer/?${new URLSearchParams({ parse: 'server', fileId: wordFile.fileId, token, name: 'async-word.docx' })}`,
  )
  await expect(page.frameLocator('iframe').locator('.viewer-doc-remote-slot').first()).toBeVisible({
    timeout: 30_000,
  })
  const frame = page.frameLocator('iframe')
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toBeVisible({ timeout: 30_000 })
  const embeddedFontCount = () => frame.locator('body').evaluate(() =>
    [...document.fonts].filter((face) => face.family === 'GenofficeLifecycleProbe').length)
  assert.equal(await embeddedFontCount(), 1)
  for (let chunk = 0; chunk < 6; chunk++) {
    const more = frame.getByRole('button', { name: '加载更多', exact: true })
    await expect(more).toBeVisible({ timeout: 30_000 })
    await more.click()
    await expect(frame.getByText('正在加载更多…', { exact: true })).toHaveCount(0, { timeout: 30_000 })
  }
  const viewport = frame.locator('.viewer-doc-remote-viewport')
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 1200', { exact: true })).toBeVisible({ timeout: 30_000 })
  const heightBefore = await frame.locator('.viewer-doc-remote-canvas').evaluate((element) => element.getBoundingClientRect().height)
  const readsBeforeReturn = firstUnitReads
  expireOnReturn = true
  await viewport.evaluate((element) => { element.scrollTop = 0 })
  await expect(frame.getByRole('alert')).toContainText('HTTP 500', { timeout: 30_000 })
  await frame.getByRole('button', { name: '重试', exact: true }).click()
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toBeVisible({ timeout: 30_000 })
  assert.ok(firstUnitReads > readsBeforeReturn, 'evicted oversized first unit must be fetched on return')
  assert.equal(expiredOnReturn, true)
  assert.equal(failedOnReturn, true)
  assert.equal(await frame.locator('.viewer-doc-remote-canvas').evaluate((element) => element.getBoundingClientRect().height), heightBefore)
  // Delay a real unit response, leave its window, then deliver the obsolete body.
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 1200', { exact: true })).toBeVisible()
  delayNextFirstUnit = true
  const cancelledRead = page.waitForEvent('requestfailed', {
    predicate: (request) => request.url().endsWith('/units/0') &&
      (request.failure()?.errorText.includes('ERR_ABORTED') ?? false),
    timeout: 15_000,
  })
  // Attach a handler immediately so a failed observation never leaks a rejection.
  void cancelledRead.catch(() => undefined)
  try {
    await viewport.evaluate((element) => { element.scrollTop = 0 })
    await expect.poll(() => delayedUnitStarted, { timeout: 10_000 }).toBe(true)
    await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 1200', { exact: true })).toBeVisible()
    releaseDelayedUnit()
    await cancelledRead
  } finally {
    releaseDelayedUnit()
  }
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 1200', { exact: true })).toBeVisible()
  await expect(frame.getByRole('alert')).toHaveCount(0)
  await viewport.evaluate((element) => { element.scrollTop = 0 })
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toBeVisible({ timeout: 30_000 })
  assert.equal(await frame.locator('.viewer-doc-remote-canvas').evaluate((element) => element.getBoundingClientRect().height), heightBefore)
  const cdp = await page.context().newCDPSession(page)
  const memorySamples: Array<{ cycle: number; usedSize: number; nodes: number }> = []
  const sampleMemory = async (cycle: number) => {
    await cdp.send('HeapProfiler.collectGarbage')
    const heap = await cdp.send('Runtime.getHeapUsage')
    const dom = await cdp.send('Memory.getDOMCounters')
    memorySamples.push({ cycle, usedSize: heap.usedSize, nodes: dom.nodes })
  }
  await sampleMemory(0)
  for (let cycle = 1; cycle <= 12; cycle++) {
    await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 1200', { exact: true })).toBeVisible()
    await viewport.evaluate((element) => { element.scrollTop = 0 })
    await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toBeVisible({ timeout: 30_000 })
    await sampleMemory(cycle)
  }
  await cdp.detach()
  const memoryReport = {
    browser: browser.version(), paragraphs: 1201, cycles: 12,
    method: 'Chromium isolate JS heap after forced GC; not process RSS',
    samples: memorySamples,
  }
  await writeFile(join(output, 'docx-memory-samples.json'), JSON.stringify(memoryReport, null, 2))
  const baseline = memorySamples[0]
  const final = memorySamples.at(-1)!
  assert.ok(final.usedSize < baseline.usedSize + 16 * 1024 * 1024,
    `post-GC heap grew by ${final.usedSize - baseline.usedSize} bytes over 12 visits`)
  assert.ok(final.nodes < baseline.nodes + 5000, 'offscreen editors must release their DOM nodes')
  assert.ok(
    wordRequests.some((url) => url.endsWith('/v2/sessions')),
    'large DOCX must use async readiness',
  )
  assert.ok(
    !wordRequests.some((url) => url.includes(`/v1/files/${wordFile.fileId}/content`)),
    'large DOCX must not download original content before preview',
  )
  assert.equal(expiredWord, true)
  assert.equal(wordRequests.filter((url) => url.endsWith('/v2/sessions')).length, 3)
  assert.equal(await embeddedFontCount(), 1, 'session recovery must reuse the document-owned face')
  assert.equal(wordRequests.filter((url) => /\/v1\/sessions\/[^/]+\/fonts\//.test(url)).length, 1)
  const latestStyles = wordRequests.filter((url) => /\/sessions\/[^/]+\/styles$/.test(url)).at(-1)!
  const sessionId = new URL(latestStyles).pathname.split('/')[3]
  const fontSession = await (await fetch(`${parser.url}/v1/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).json() as { fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean }> }
  assert.ok(fontSession.fonts.length > 0)
  await frame.locator('body').evaluate(async (_element, input) => {
    const { DocxFontScope } = await import(input.moduleUrl)
    const scope = new DocxFontScope()
    const probe = { ...input.font, family: 'GenofficeScopeCleanupProbe' }
    if ([...document.fonts].filter((face) => face.family === probe.family).length !== 0) throw new Error('Unexpected preexisting probe font')
    try {
      await scope.load(location.origin, input.sessionId, [probe],
        { Authorization: `Bearer ${input.token}` }, new AbortController().signal)
      if ([...document.fonts].filter((face) => face.family === probe.family).length !== 1) throw new Error('Real embedded font was not registered')
    } finally {
      scope.close()
    }
    if ([...document.fonts].filter((face) => face.family === probe.family).length !== 0) throw new Error('Closed font scope retained a browser face')
  }, { moduleUrl: `${origin}/viewer/docx-font-scope.ts`, sessionId, font: fontSession.fonts[0], token })
  assert.equal(await embeddedFontCount(), 1, 'closing another scope must preserve the viewer face')
  await page.route('**/docx-image-probe.svg', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    await route.fulfill({ contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="120"><rect width="12" height="120" fill="blue"/></svg>' })
  })
  const imageMeasurement = await frame.locator('body').evaluate(async (_element, input) => {
    const { waitForDocxImages } = await import(input.moduleUrl)
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-10000px;visibility:hidden'
    const image = document.createElement('img')
    image.src = input.imageUrl
    host.append(image)
    document.body.append(host)
    try {
      const before = image.getBoundingClientRect().height
      await waitForDocxImages([image])
      return { before, after: image.getBoundingClientRect().height, complete: image.complete }
    } finally {
      host.remove()
    }
  }, { moduleUrl: `${origin}/viewer/docx-image-ready.ts`, imageUrl: `${origin}/docx-image-probe.svg` })
  assert.equal(imageMeasurement.complete, true)
  assert.ok(imageMeasurement.before < imageMeasurement.after)
  assert.equal(imageMeasurement.after, 120)
  await viewport.evaluate((element) => { element.scrollTop = 220 })
  const anchorProbe = await viewport.evaluate((element) => {
    const top = element.getBoundingClientRect().top
    const paragraph = [...element.querySelectorAll<HTMLElement>('.viewer-doc-remote-page p[data-idx]')]
      .find((node) => node.getBoundingClientRect().top >= top + 10 && node.textContent?.startsWith('Cache paragraph'))!
    return { text: paragraph.textContent!, offset: paragraph.getBoundingClientRect().top - top }
  })
  await frame.locator('body').evaluate(() => {
    const style = document.createElement('style')
    style.id = 'docx-reflow-probe'
    style.textContent = '.doc-page [data-idx="0"] { min-height:600px !important; }'
    document.head.append(style)
  })
  await expect.poll(async () => frame.locator('.viewer-doc-remote-canvas')
    .evaluate((element) => element.getBoundingClientRect().height), { timeout: 15_000 }).toBeGreaterThan(heightBefore + 100)
  const anchoredParagraph = frame.locator('.viewer-doc-remote-page').getByText(anchorProbe.text, { exact: true })
  await expect(anchoredParagraph).toBeVisible()
  const anchorOffset = await anchoredParagraph.evaluate((element) => element.getBoundingClientRect().top -
    element.closest('.viewer-doc-remote-viewport')!.getBoundingClientRect().top)
  assert.ok(Math.abs(anchorOffset - anchorProbe.offset) <= 32,
    `block anchor moved ${anchorOffset - anchorProbe.offset}px after visible content resized`)
  await frame.locator('body').evaluate(() => document.getElementById('docx-reflow-probe')!.remove())
  await expect.poll(async () => frame.locator('.viewer-doc-remote-canvas')
    .evaluate((element) => element.getBoundingClientRect().height), { timeout: 15_000 }).toBe(heightBefore)
  await viewport.evaluate((element) => { element.scrollTop = 0 })
  await expect(frame.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toBeVisible()
  assert.equal(
    (await wordHealth()).artifacts.buildsStarted - beforeWord.artifacts.buildsStarted,
    1,
    'expired DOCX session must reopen from the artifact without reparsing',
  )
  assert.deepEqual(errors, [])
  await page.screenshot({ path: join(output, 'async-docx-flow.png'), fullPage: true })
  // Keep the browser document alive while replacing the actual React component's file.
  const switchedWord = await JSZip.loadAsync(await fontFixture.generateAsync({ type: 'nodebuffer' }))
  switchedWord.file('word/document.xml', (await switchedWord.file('word/document.xml')!.async('string'))
    .replace(/<w:body[^>]*>[\s\S]*?<\/w:body>/,
      '<w:body><w:p><w:r><w:t>Switched document B</w:t></w:r></w:p></w:body>'))
  const switchedUpload = await fetch(`${parser.url}/v1/files`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: await switchedWord.generateAsync({ type: 'nodebuffer' }),
  })
  assert.equal(switchedUpload.status, 201)
  const switchedFile = await switchedUpload.json() as { fileId: string }
  const reactUrl = wordRequests.find((url) => new URL(url).pathname.endsWith('/react.js'))
  const domUrl = wordRequests.find((url) => new URL(url).pathname.endsWith('/react-dom_client.js'))
  assert.ok(reactUrl && domUrl)
  const mounted = await frame.locator('body').evaluateHandle(async (_element, input) => {
    const reactModule = await import(input.reactUrl)
    const React = reactModule.default ?? reactModule
    const domModule = await import(input.domUrl)
    const createRoot = domModule.createRoot ?? domModule.default.createRoot
    const { DocsRemote } = await import(input.moduleUrl)
    const container = document.createElement('div')
    container.id = 'docx-switch-probe'
    container.style.cssText = 'position:fixed;inset:20px;z-index:10000;background:white'
    document.body.append(container)
    const root = createRoot(container)
    root.render(React.createElement(DocsRemote, { server: location.origin, fileId: input.fileId, token: input.token }))
    return { root, container, React, DocsRemote, readyDescriptor: undefined as PropertyDescriptor | undefined,
      releaseFontGate: undefined as (() => void) | undefined }
  }, { reactUrl, domUrl, moduleUrl: `${origin}/viewer/docs-remote.tsx`, fileId: wordFile.fileId, token })
  try {
    const probe = frame.locator('#docx-switch-probe')
    await expect(probe.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toBeVisible({ timeout: 30_000 })
    assert.equal(await embeddedFontCount(), 2)
    await expect.poll(async () => frame.locator('body > div[style*="-10000px"]').count()).toBe(0)
    await mounted.evaluate((state) => {
      state.readyDescriptor = Object.getOwnPropertyDescriptor(document.fonts, 'ready')
      const gate = new Promise<void>((resolve) => { state.releaseFontGate = resolve })
      Object.defineProperty(document.fonts, 'ready', { configurable: true, value: gate })
      document.fonts.dispatchEvent(new Event('loadingdone'))
    })
    await expect.poll(async () => frame.locator('body > div[style*="-10000px"]').count()).toBeGreaterThanOrEqual(2)
    const blockedMeasurements = await frame.locator('body > div[style*="-10000px"]').count()
    const switchStarted = page.waitForResponse((response) => response.request().method() === 'POST' &&
      response.url().endsWith('/v2/sessions') && response.request().postDataJSON().fileId === switchedFile.fileId)
    void switchStarted.catch(() => undefined)
    await mounted.evaluate((state, input) => {
      state.root.render(state.React.createElement(state.DocsRemote,
        { server: location.origin, fileId: input.fileId, token: input.token }))
    }, { fileId: switchedFile.fileId, token })
    await switchStarted
    await expect.poll(async () => frame.locator('body > div[style*="-10000px"]').count(),
      { timeout: 500 }).toBeLessThan(blockedMeasurements)
    await mounted.evaluate((state) => {
      if (state.readyDescriptor) Object.defineProperty(document.fonts, 'ready', state.readyDescriptor)
      else Reflect.deleteProperty(document.fonts, 'ready')
      state.releaseFontGate?.()
      state.releaseFontGate = undefined
    })
    await expect(probe.locator('.viewer-doc-remote-page').getByText('Switched document B', { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(probe.locator('.viewer-doc-remote-page').getByText('Cache paragraph 0', { exact: true })).toHaveCount(0)
    assert.equal(await embeddedFontCount(), 1, 'component file replacement must remove only the old owned face')
  } finally {
    await mounted.evaluate((state) => {
      if (state.releaseFontGate) {
        if (state.readyDescriptor) Object.defineProperty(document.fonts, 'ready', state.readyDescriptor)
        else Reflect.deleteProperty(document.fonts, 'ready')
        state.releaseFontGate?.()
      }
      state.root.unmount()
      state.container.remove()
    })
    await mounted.dispose()
  }
  assert.equal(await embeddedFontCount(), 1)
  assert.deepEqual(errors, [])
  console.log(
    JSON.stringify({
      ok: true,
      failedSaveRetried: true,
      restartCacheHit: true,
      removedFromHistory: true,
      asyncDocxPreviewWithoutOriginalDownload: true,
      expiredDocxRecoveredWithoutReparse: true,
      evictedDocxUnitRefetchedAfterExpiry: true,
      docxPageHeightStableAfterReturn: true,
      docxReturnFailureRetry: true,
      delayedDocxWindowRequestCancelled: true,
      embeddedDocxFontRecoveryAndCleanup: true,
      delayedImageMeasuredAfterLoad: true,
      visibleDocxResizeReflowAndBlockAnchor: true,
      docxComponentFileSwitchIsolated: true,
      closedDocxFontWaitReleasedBeforeReady: true,
      docxMemoryReport: join(output, 'docx-memory-samples.json'),
      screenshot: join(output, 'library-flow.png'),
    }),
  )
} finally {
  await browser?.close()
  await frontend.close()
  await parser.close().catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
}
