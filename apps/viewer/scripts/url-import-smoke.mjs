import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright-core'
import { PDFDocument } from 'pdf-lib'
import { app, root } from './paths.mjs'
const dir = await mkdtemp(join(tmpdir(), 'viewer-url-browser-'))
process.env.VIEWER_DATA_DIR = dir
let browser, tab, server, origin
const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}
try {
  const doc = await PDFDocument.create(),
    page = doc.addPage([600, 800])
  page.drawText('URL imported PDF', { x: 60, y: 730 })
  const pdf = Buffer.from(await doc.save())
  const slides = await readFile(
    resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
  )
  const word = await readFile(resolve(root, 'fixtures/generated/simple.docx'))
  const hits = []
  origin = createServer((req, res) => {
    hits.push(req.url)
    const path = new URL(req.url, 'http://origin').pathname
    if (path === '/redirect') {
      res.writeHead(302, { Location: '/document?token=signed' })
      return res.end()
    }
    if (path === '/document') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition':
          "attachment; filename*=UTF-8''%E8%BF%9C%E7%A8%8B%E6%96%87%E6%A1%A3.pdf",
      })
      return res.end(pdf)
    }
    if (path === '/slides.pptx') return res.end(slides)
    if (path === '/word') return res.end(word)
    if (path === '/share') return res.end('<html>Login required</html>')
    res.writeHead(404)
    res.end('Missing')
  })
  const source = await listen(origin)
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
  tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  tab.on('pageerror', (e) => errors.push(e.message))
  await tab.goto(base)
  const input = tab.getByLabel('文件 URL'),
    button = tab.getByRole('button', { name: '导入 URL', exact: true })
  await tab.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  assert.equal(await button.isDisabled(), true)
  let previous
  async function importUrl(path) {
    await input.fill(source + path)
    await button.click()
    await tab.locator('iframe').waitFor()
    const frame = await (await tab.locator('iframe').elementHandle()).contentFrame()
    const session = new URL(frame.url()).searchParams.get('session')
    if (previous)
      assert.equal((await tab.request.get(`${base}/api/view-sessions/${previous}`)).status(), 404)
    previous = session
    return frame
  }
  const importedPdf = await importUrl('/redirect')
  await importedPdf.locator('.viewer-pdf-page canvas').first().waitFor()
  await importedPdf.getByText('URL imported PDF', { exact: true }).waitFor()
  assert.equal(await tab.locator('iframe').getAttribute('title'), '远程文档.pdf')
  assert.ok(hits.includes('/document?token=signed'))
  const output = resolve(app, 'test-results/url-import')
  await mkdir(output, { recursive: true })
  await tab.screenshot({ path: join(output, 'pdf-url.png') })
  await tab.request.delete(`${base}/api/view-sessions/${previous}`)
  await tab.getByRole('button', { name: '重新打开', exact: true }).click()
  await tab.locator('iframe').waitFor()
  const recovered = await (await tab.locator('iframe').elementHandle()).contentFrame()
  previous = new URL(recovered.url()).searchParams.get('session')
  await recovered.locator('.viewer-pdf-page canvas').first().waitFor()
  assert.equal(hits.filter((path) => path === '/redirect').length, 2)
  console.log(
    'URL PDF: redirected signed URL, UTF-8 filename, original rendering and expired-session reimport passed',
  )
  const importedSlides = await importUrl('/slides.pptx')
  await importedSlides.locator('.viewer-thumbs button').last().waitFor()
  assert.equal(await importedSlides.locator('.viewer-thumbs button').count(), 5)
  const importedWord = await importUrl('/word')
  await importedWord.locator('.pv-page').first().waitFor({ timeout: 30000 })
  assert.equal(await importedWord.locator('[contenteditable=true]').count(), 0)
  console.log('URL PPT/Word: original slide worker and readonly document pagination passed')
  await input.fill(source + '/share')
  await button.click()
  await tab.getByRole('alert').filter({ hasText: '文件下载直链' }).waitFor()
  assert.equal(await tab.locator('iframe').count(), 0)
  // A failed URL import must not break the existing local-upload entry point.
  await tab.getByLabel('打开文件').setInputFiles(resolve(root, 'fixtures/generated/simple.docx'))
  await tab.locator('iframe').waitFor()
  const local = await (await tab.locator('iframe').elementHandle()).contentFrame()
  await local.locator('.pv-page').first().waitFor({ timeout: 30000 })
  assert.deepEqual(errors, [])
  console.log('URL failure feedback and local upload recovery passed')
} finally {
  await browser?.close()
  for (const endpoint of [server, origin])
    if (endpoint) await new Promise((resolve) => endpoint.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
