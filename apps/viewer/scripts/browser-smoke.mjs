import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { chromium } from 'playwright-core'
import { PDFDocument } from 'pdf-lib'
import JSZip from 'jszip'
import { app, root } from './paths.mjs'
const dir = await mkdtemp(join(tmpdir(), 'genoffice-viewer-browser-'))
process.env.VIEWER_DATA_DIR = dir
let server,
  url = process.env.VIEWER_TEST_URL
if (!url) {
  const { createViewerServer } = await import(new URL('../dist/server/index.mjs', import.meta.url))
  server = await createViewerServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${server.address().port}`
}
const output = resolve(app, 'test-results')
await mkdir(output, { recursive: true })
let browser, tab
try {
  const doc = await PDFDocument.create(),
    page = doc.addPage([600, 800]),
    form = doc.getForm()
  page.drawText('Read only PDF', { x: 60, y: 740 })
  const field = form.createTextField('customer')
  field.setText('Existing value')
  field.addToPage(page, { x: 60, y: 600, width: 250, height: 30 })
  const checkbox = form.createCheckBox('accepted')
  checkbox.addToPage(page, { x: 60, y: 540 })
  checkbox.check()
  const pdfPath = resolve(output, 'forms.pdf')
  await writeFile(pdfPath, await doc.save())
  browser = await chromium.launch({
    executablePath:
      process.env.VIEWER_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  tab = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })
  const errors = []
  tab.on('pageerror', (error) => errors.push(error.message))
  tab.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') console.error(message.text())
  })
  tab.on('response', (response) => {
    if (response.url().endsWith('/altchunks')) console.log('altChunk response', response.status())
  })
  await tab.goto(url)
  const input = tab.getByLabel('打开文件')
  await input.waitFor({ state: 'attached' })
  await tab.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  let previous
  async function open(path) {
    await input.setInputFiles(path)
    await tab.locator('iframe').waitFor()
    const frame = await tab
      .locator('iframe')
      .elementHandle()
      .then((element) => element.contentFrame())
    const session = new URL(frame.url()).searchParams.get('session')
    if (previous)
      assert.equal((await tab.request.get(`${url}/api/view-sessions/${previous}`)).status(), 404)
    previous = session
    return frame
  }
  const slides = await open(
    resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
  )
  await slides.locator('.viewer-thumbs button').last().waitFor()
  assert.equal(await slides.locator('.viewer-thumbs button').count(), 5)
  await slides.getByRole('button', { name: '下一页', exact: true }).click()
  assert.equal(await slides.locator('.viewer-bar span').first().textContent(), '2 / 5')
  await tab.screenshot({ path: resolve(output, 'pptx.png') })
  await slides.getByRole('button', { name: '开始放映' }).click()
  await slides.locator('.slideshow').waitFor()
  await slides.locator('.slideshow').focus()
  await tab.keyboard.press('ArrowRight')
  await slides.waitForFunction(() =>
    document.querySelector('.ss-counter')?.textContent?.includes('3'),
  )
  await tab.keyboard.press('Escape')
  await slides.locator('.slideshow').waitFor({ state: 'detached' })
  console.log('PPT: original canvas, thumbnails, navigation and slideshow passed')
  const pdf = await open(pdfPath)
  await pdf.locator('.viewer-pdf-page canvas').first().waitFor()
  await pdf.waitForFunction(() =>
    [...document.querySelectorAll('input')].some((el) => el.value === 'Existing value'),
  )
  assert.ok(
    await pdf
      .locator('input')
      .evaluateAll((elements) =>
        elements.some((el) => el.value === 'Existing value' && (el.readOnly || el.disabled)),
      ),
  )
  assert.equal(await pdf.locator('input[type=checkbox]').isChecked(), true)
  assert.equal(await pdf.locator('input[type=checkbox]').isDisabled(), true)
  await pdf.getByRole('button', { name: '旋转', exact: true }).click()
  await pdf.waitForFunction(
    () => document.querySelector('.viewer-pdf-page').style.width === '800px',
  )
  await tab.screenshot({ path: resolve(output, 'pdf.png') })
  console.log('PDF: original canvas, saved form values, read-only widgets and rotation passed')
  const word = await open(resolve(root, 'fixtures/generated/kitchen-sink.docx'))
  await word.locator('.pv-page').first().waitFor({ timeout: 30000 })
  assert.equal(await word.locator('[contenteditable=true]').count(), 0)
  assert.ok((await word.locator('.pv-content').first().textContent()).length > 50)
  assert.ok((await word.locator('.pv-content table').count()) > 0)
  await tab.screenshot({ path: resolve(output, 'docx.png') })
  console.log('Word: original pagination, tables and read-only DOM passed')
  const zip = await JSZip.loadAsync(await readFile(resolve(root, 'fixtures/generated/simple.docx')))
  const xml = await zip.file('word/document.xml').async('string')
  zip.file(
    'word/document.xml',
    xml.replace(
      /(<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*<\/w:body>)/,
      '<w:altChunk r:id="rIdViewerHTML"/>$1',
    ),
  )
  const rels = await zip.file('word/_rels/document.xml.rels').async('string')
  zip.file(
    'word/_rels/document.xml.rels',
    rels.replace(
      '</Relationships>',
      '<Relationship Id="rIdViewerHTML" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="viewer.html"/></Relationships>',
    ),
  )
  const types = await zip.file('[Content_Types].xml').async('string')
  zip.file(
    '[Content_Types].xml',
    types.replace(
      '</Types>',
      '<Override PartName="/word/viewer.html" ContentType="text/html"/></Types>',
    ),
  )
  zip.file(
    'word/viewer.html',
    '<html><body><h1>Viewer altChunk rendered</h1><p>Original Chromium layout converter</p></body></html>',
  )
  const altPath = resolve(output, 'altchunk.docx')
  await writeFile(altPath, await zip.generateAsync({ type: 'nodebuffer' }))
  const altWord = await open(altPath)
  await altWord
    .locator('.pv-content')
    .filter({ hasText: 'Viewer altChunk rendered' })
    .first()
    .waitFor({ timeout: 20000 })
  assert.equal(await altWord.locator('[contenteditable=true]').count(), 0)
  console.log(
    'Word altChunk: browser worker fallback, Node converter and original pagination passed',
  )
  assert.deepEqual(errors, [])
  console.log(`Screenshots: ${output}`)
} catch (error) {
  for (const frame of tab?.frames() || [])
    console.error(frame.url(), await frame.locator('body').innerText())
  throw error
} finally {
  await browser?.close()
  if (server) await new Promise((resolve) => server.close(resolve))
  await rm(dir, { recursive: true, force: true })
}
