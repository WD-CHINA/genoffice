import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { PDFDocument } from 'pdf-lib'
import { app, root } from './paths.mjs'

const dir = await mkdtemp(join(tmpdir(), 'viewer-ui-'))
process.env.VIEWER_DATA_DIR = dir
const output = resolve(app, 'test-results/ui-options')
await mkdir(output, { recursive: true })
let server, source, browser
const listen = async (endpoint) => {
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${endpoint.address().port}`
}

try {
  const pdf = await PDFDocument.create()
  pdf.addPage([600, 800]).drawText('Viewer link options', { x: 60, y: 740 })
  const files = {
    '/reading.pdf': Buffer.from(await pdf.save()),
    '/slides.pptx': await readFile(
      resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
    ),
    '/word.docx': await readFile(resolve(root, 'fixtures/generated/kitchen-sink.docx')),
  }
  const hits = []
  source = createServer((req, res) => {
    hits.push(req.url)
    const file = files[new URL(req.url, 'http://localhost').pathname]
    if (file) return res.end(file)
    res.end('<html>Not a document</html>')
  })
  const sourceUrl = await listen(source)
  const { createViewerServer } = await import('../dist/server/index.mjs')
  server = await createViewerServer({
    sessionTtlMs: 1500,
    urlImport: { allowPrivateNetwork: true },
  })
  const base = await listen(server)
  browser = await chromium.launch({
    executablePath:
      process.env.VIEWER_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  const errors = []
  const context = await browser.newContext({ viewport: { width: 1130, height: 800 } })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  const go = async (params = {}) => {
    await page.goto(`${base}/?${new URLSearchParams(params)}`)
    await page.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  }
  const frameFor = async (selector) => {
    await page.locator('iframe').waitFor()
    const frame = await (await page.locator('iframe').elementHandle()).contentFrame()
    await frame.locator(selector).first().waitFor({ timeout: 30000 })
    return frame
  }

  await go()
  assert.equal(await page.locator('.viewer-file-bar').isVisible(), true)
  assert.equal(await page.getByLabel('打开文件').isVisible(), true)
  assert.equal(await page.getByLabel('文件 URL').isVisible(), true)
  await go({ showImport: 'false', showUrlImport: '0' })
  assert.equal(await page.locator('.viewer-file-bar').isVisible(), true)
  assert.equal(await page.locator('.viewer-button').isVisible(), false)
  assert.equal(await page.getByLabel('文件 URL').isVisible(), false)

  for (const [path, selector] of [
    ['/reading.pdf', '.viewer-pdf-page canvas'],
    ['/slides.pptx', '.viewer-thumbs button'],
    ['/word.docx', '.pv-page'],
  ]) {
    const sourceLink = `${sourceUrl}${path}?signature=a%2Bb&token=keep`
    const before = hits.length
    await go({ url: sourceLink, embed: '1' })
    // Hidden sidebars still have DOM content, so test the actual document view for PPT.
    const frame = await frameFor(path.endsWith('pptx') ? '.viewer-slide-stage canvas' : selector)
    assert.equal(await page.locator('.viewer-file-bar').isVisible(), false)
    assert.equal(await page.locator('.viewer-button').isVisible(), false)
    assert.equal(await page.getByLabel('文件 URL').isVisible(), false)
    assert.equal(await frame.locator('header.viewer-bar').isVisible(), false)
    assert.equal(
      await frame.locator('.viewer-navigation,.viewer-thumbs').first().isVisible(),
      false,
    )
    assert.equal(
      await frame
        .locator('.viewer-search-controls')
        .isVisible()
        .catch(() => false),
      false,
    )
    const params = new URL(frame.url()).searchParams
    for (const key of ['showToolbar', 'showErrors', 'showSidebar'])
      assert.equal(params.get(key), '0')
    assert.equal(hits.length - before, 1, 'Automatic import runs once and preserves the signed URL')
    assert.equal(hits.at(-1), `${path}?signature=a%2Bb&token=keep`)
    await page.screenshot({ path: join(output, `${path.split('.').at(-1)}-embed.png`) })
    // The Host heartbeat continues when every visible control is hidden.
    if (path.endsWith('pdf')) {
      await page.waitForTimeout(1800)
      const response = await page.request.get(`${base}/api/view-sessions/${params.get('session')}`)
      assert.equal(response.status(), 200)
    }
  }

  await go({
    url: `${sourceUrl}/reading.pdf`,
    embed: '1',
    showHeader: '1',
    showToolbar: 'true',
    showSidebar: '1',
  })
  let frame = await frameFor('.viewer-pdf-page canvas')
  assert.equal(await page.locator('.viewer-file-bar').isVisible(), true)
  assert.equal(await page.locator('.viewer-button').isVisible(), false)
  assert.equal(await frame.locator('header.viewer-bar').isVisible(), true)
  assert.equal(await frame.locator('.viewer-navigation').isVisible(), true)
  // Direct preview links also honor the flags and can override them on reload.
  const previewUrl = new URL(frame.url())
  previewUrl.searchParams.set('showToolbar', '0')
  previewUrl.searchParams.set('showSidebar', '0')
  const direct = await page.context().newPage()
  await direct.goto(previewUrl.href)
  await direct.locator('.viewer-pdf-page canvas').first().waitFor()
  assert.equal(await direct.locator('header.viewer-bar').isVisible(), false)
  assert.equal(await direct.locator('.viewer-navigation').isVisible(), false)
  await direct.close()

  await go({ url: `${sourceUrl}/share`, embed: '1' })
  await page.locator('[role=alert]').waitFor({ state: 'attached' })
  assert.equal(await page.locator('[role=alert]').isVisible(), false)
  await go({ url: `${sourceUrl}/share`, embed: '1', showErrors: '1' })
  await page.getByRole('alert').waitFor()

  // Parser/resource failures inside each format must obey the same error option.
  for (const [path, route] of [
    ['/reading.pdf', '**/api/view-sessions/*/content'],
    ['/word.docx', '**/api/view-sessions/*/content'],
    ['/slides.pptx', '**/api/view-sessions/*/slides'],
  ]) {
    await page.route(route, (request) =>
      request.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'UI error visibility fixture' }),
      }),
    )
    for (const showErrors of ['0', '1']) {
      await go({ url: `${sourceUrl}${path}`, embed: '1', showErrors })
      await page.locator('iframe').waitFor()
      frame = await (await page.locator('iframe').elementHandle()).contentFrame()
      await frame.locator('[role=alert]').first().waitFor({ state: 'attached', timeout: 30000 })
      assert.equal(await frame.locator('[role=alert]').first().isVisible(), showErrors === '1')
    }
    await page.unroute(route)
  }
  assert.deepEqual(errors, [])
  console.log(
    'Link UI: defaults, individual switches, three-format automatic URL import, embed overrides, iframe propagation, heartbeat and error visibility passed',
  )
} finally {
  await browser?.close()
  for (const endpoint of [server, source])
    if (endpoint) await new Promise((resolve) => endpoint.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
