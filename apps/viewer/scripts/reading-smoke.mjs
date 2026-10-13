import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import JSZip from 'jszip'
import officeCrypto from 'officecrypto-tool'
import { app, root } from './paths.mjs'
const dir = await mkdtemp(join(tmpdir(), 'viewer-reading-'))
process.env.VIEWER_DATA_DIR = dir
const { createViewerServer } = await import('../dist/server/index.mjs')
const server = await createViewerServer({ sessionTtlMs: 1500 })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}`
const output = resolve(app, 'test-results/reading')
await mkdir(output, { recursive: true })
let browser, tab
try {
  const pdf = await PDFDocument.create()
  pdf.setTitle('Viewer Reading Regression')
  const pdfPages = []
  for (let i = 0; i < 3; i++) {
    const page = pdf.addPage([600, 800])
    pdfPages.push(page)
    page.drawText(`Chapter ${i + 1}`, { x: 60, y: 740, size: 24 })
    for (let n = 0; n < 8; n++)
      page.drawText(`Body paragraph ${n + 1}. Reading document.`, {
        x: 60,
        y: 690 - n * 35,
        size: 12,
      })
    page.drawText('viewerneedle', { x: 60, y: 330, size: 12 })
  }
  const note = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [60, 650, 80, 670],
      Contents: PDFHexString.fromText('Saved note body'),
      T: PDFHexString.fromText('Alice'),
      CreationDate: PDFHexString.fromText('D:20261013090000Z'),
      Name: 'Comment',
      P: pdfPages[0].ref,
    }),
  )
  const reply = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: [60, 650, 80, 670],
      Contents: PDFHexString.fromText('Saved reply body'),
      T: PDFHexString.fromText('Bob'),
      IRT: note,
      RT: 'R',
      P: pdfPages[0].ref,
    }),
  )
  pdfPages[0].node.set(PDFName.of('Annots'), pdf.context.obj([note, reply]))
  // A corrupt internal destination must remain harmless.
  const broken = pdf.context.register(
    pdf.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [60, 180, 200, 210],
      Dest: PDFHexString.fromText('missing-destination'),
    }),
  )
  pdfPages[1].node.set(PDFName.of('Annots'), pdf.context.obj([broken]))
  const pdfPath = join(output, 'reading.pdf')
  await writeFile(pdfPath, await pdf.save())

  const zip = await JSZip.loadAsync(await readFile(resolve(root, 'fixtures/generated/simple.docx')))
  const originalXml = await zip.file('word/document.xml').async('string')
  const section = originalXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0]
  assert.ok(section)
  const paragraphs =
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Viewer Alpha</w:t></w:r></w:p><w:p><w:r><w:t>viewerneedle viewerneedle</w:t></w:r></w:p><w:p><w:hyperlink w:anchor="ViewerTarget"><w:r><w:t>Jump to Viewer Beta</w:t></w:r></w:hyperlink></w:p><w:p><w:ins w:id="9" w:author="Reviewer" w:date="2026-10-13T09:00:00Z"><w:r><w:t>InsertedTest</w:t></w:r></w:ins><w:del w:id="10" w:author="Reviewer" w:date="2026-10-13T09:00:00Z"><w:r><w:delText>DeletedTest</w:delText></w:r></w:del></w:p><w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:bookmarkStart w:id="22" w:name="ViewerTarget"/><w:r><w:t>Viewer Beta</w:t></w:r><w:bookmarkEnd w:id="22"/></w:p><w:p><w:r><w:t>viewerneedle</w:t></w:r></w:p>'
  zip.file(
    'word/document.xml',
    originalXml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:background w:color="FFF4DB"/><w:body>${paragraphs}${section}</w:body>`,
    ),
  )
  const wordBytes = await zip.generateAsync({ type: 'nodebuffer' })
  const wordPath = join(output, 'reading.docx')
  await writeFile(wordPath, wordBytes)
  const encryptedPath = join(output, 'protected.docx')
  await writeFile(
    encryptedPath,
    await officeCrypto.encrypt(wordBytes, { password: 'viewer-secret' }),
  )

  const mixedZip = await JSZip.loadAsync(wordBytes)
  const body = (name, count) =>
    Array.from(
      { length: count },
      (_, i) =>
        `<w:p><w:r><w:t>${name} ${i + 1}: ${'Original column measurement and section grid. '.repeat(8)}</w:t></w:r></w:p>`,
    ).join('')
  const sectionA =
    '<w:sectPr><w:type w:val="nextPage"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/><w:cols w:num="2" w:equalWidth="0" w:space="720"><w:col w:w="5500" w:space="720"/><w:col w:w="2806" w:space="0"/></w:cols><w:docGrid w:type="linesAndChars" w:linePitch="360" w:charSpace="1024"/></w:sectPr>'
  const sectionB =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1800" w:right="1800" w:bottom="1440" w:left="1800"/><w:cols w:num="1"/><w:docGrid w:type="lines" w:linePitch="480"/></w:sectPr>'
  mixedZip.file(
    'word/document.xml',
    originalXml.replace(
      /<w:body>[\s\S]*<\/w:body>/,
      `<w:body>${body('Section A', 12)}<w:p><w:pPr>${sectionA}</w:pPr></w:p>${body('Section B', 6)}${sectionB}</w:body>`,
    ),
  )
  const mixedPath = join(output, 'mixed-columns.docx')
  await writeFile(mixedPath, await mixedZip.generateAsync({ type: 'nodebuffer' }))
  const lazyZip = await JSZip.loadAsync(
    await readFile(resolve(root, 'fixtures/generated/kitchen-sink.docx')),
  )
  const imagePart = Object.keys(lazyZip.files).find((n) => /^word\/media\/.*\.png$/.test(n))
  lazyZip.file(
    imagePart,
    Buffer.concat([
      await lazyZip.file(imagePart).async('nodebuffer'),
      Buffer.alloc(2 * 1024 * 1024),
    ]),
  )
  const lazyPath = join(output, 'lazy-media.docx')
  await writeFile(
    lazyPath,
    await lazyZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
  )

  const deckZip = await JSZip.loadAsync(
    await readFile(resolve(root, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')),
  )
  const slideXml = await deckZip.file('ppt/slides/slide1.xml').async('string')
  const linkedXml = slideXml.replace(
    /(<p:sp\b[\s\S]*?<p:cNvPr\b[^>]*)(\/>)/,
    '$1><a:hlinkClick r:id="" action="ppaction://hlinkshowjump?jump=nextslide"/></p:cNvPr>',
  )
  assert.notEqual(linkedXml, slideXml)
  deckZip.file('ppt/slides/slide1.xml', linkedXml)
  const presentation = await deckZip.file('ppt/presentation.xml').async('string')
  deckZip.file(
    'ppt/presentation.xml',
    presentation.replace(
      '</p:presentation>',
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Viewer Retry Font"/><p:regular r:id="rIdViewerFont"/></p:embeddedFont></p:embeddedFontLst></p:presentation>',
    ),
  )
  const presentationRels = await deckZip.file('ppt/_rels/presentation.xml.rels').async('string')
  deckZip.file(
    'ppt/_rels/presentation.xml.rels',
    presentationRels.replace(
      '</Relationships>',
      '<Relationship Id="rIdViewerFont" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/viewer.fntdata"/></Relationships>',
    ),
  )
  deckZip.file(
    'ppt/fonts/viewer.fntdata',
    await readFile(resolve(root, 'packages/ui/src/fonts/Carlito-Regular.ttf')),
  )
  for (const part of Object.keys(deckZip.files).filter((p) =>
    /^ppt\/theme\/theme\d+\.xml$/.test(p),
  ))
    deckZip.file(
      part,
      (await deckZip.file(part).async('string')).replace(
        /<a:latin\b[^>]*\/>/g,
        '<a:latin typeface="Viewer Retry Font"/>',
      ),
    )
  const deckPath = join(output, 'linked.pptx')
  await writeFile(deckPath, await deckZip.generateAsync({ type: 'nodebuffer' }))

  browser = await chromium.launch({
    executablePath:
      process.env.VIEWER_CHROME_PATH ||
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  })
  tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  tab.on('pageerror', (e) => errors.push(e.message))
  const fontAttempts = new Map()
  await tab.route('**/api/view-sessions/*/fonts/*', async (route) => {
    const path = route.request().url(),
      attempt = (fontAttempts.get(path) || 0) + 1
    fontAttempts.set(path, attempt)
    if (attempt < 3) await route.fulfill({ status: 503, body: 'Temporary font failure' })
    else await route.continue()
  })
  await tab.goto(url)
  const input = tab.getByLabel('打开文件')
  await input.waitFor()
  await tab.waitForFunction(() => !document.querySelector('input[type=file]').disabled)
  async function open(path) {
    await input.setInputFiles(path)
    await tab.locator('iframe').waitFor()
    return (await tab.locator('iframe').elementHandle()).contentFrame()
  }
  const slides = await open(deckPath)
  await slides.locator('.viewer-thumbs button').last().waitFor()
  const session = new URL(slides.url()).searchParams.get('session')
  const data = await (await tab.request.get(`${url}/api/view-sessions/${session}/slides`)).json()
  assert.ok(data.fonts.length)
  assert.equal(data.measurements.length, 0)
  assert.ok([...fontAttempts.values()].every((attempt) => attempt === 3))
  assert.equal(await slides.locator('[role=alert]').count(), 0)
  await tab.unroute('**/api/view-sessions/*/fonts/*')
  const linked = data.playback[0].links[0]
  assert.ok(linked)
  const node = data.slides[0].nodes.find((n) => n.sourceId === linked.sourceId)
  assert.ok(node)
  const stage = slides.locator('.viewer-slide-stage')
  const width = (await stage.boundingBox()).width,
    ratio = width / data.slides[0].widthPx
  await stage.click({
    position: {
      x: (node.box.x + node.box.w / 2) * ratio,
      y: (node.box.y + node.box.h / 2) * ratio,
    },
  })
  assert.equal(await slides.getByLabel('PPT 页码').inputValue(), '2')
  await slides.getByLabel('PPT 页码').fill('4')
  assert.equal(await slides.locator('.viewer-bar span').first().textContent(), '4 / 5')
  await slides.getByRole('button', { name: '适合宽度', exact: true }).click()
  const fitWidth = (await stage.boundingBox()).width
  await slides.getByRole('button', { name: '缩小', exact: true }).click()
  await slides.waitForFunction(
    (w) => document.querySelector('.viewer-slide-stage').getBoundingClientRect().width < w,
    fitWidth,
  )
  console.log('PPT: preview link hit-test, page input, fit and manual zoom passed')

  const pdfFrame = await open(pdfPath)
  await pdfFrame.locator('.viewer-pdf-page canvas').first().waitFor()
  assert.equal(await pdfFrame.locator('.viewer-navigation button[data-idx]').count(), 3)
  await pdfFrame.getByRole('button', { name: '目录', exact: true }).click()
  await pdfFrame.getByRole('treeitem', { name: /Chapter 2/ }).waitFor()
  await pdfFrame.getByRole('treeitem', { name: /Chapter 2/ }).click()
  await pdfFrame.waitForFunction(
    () => document.querySelector('[aria-label="PDF 页码"]').value === '2',
  )
  await pdfFrame.getByLabel('搜索 PDF').fill('viewerneedle')
  await pdfFrame.getByRole('button', { name: '搜索', exact: true }).click()
  await pdfFrame.getByRole('status').filter({ hasText: '1/3' }).waitFor()
  assert.ok(await pdfFrame.locator('.pdf-search-hit').count())
  await pdfFrame.getByRole('button', { name: '下一处', exact: true }).click()
  await pdfFrame.waitForFunction(
    () => document.querySelector('[aria-label="PDF 页码"]').value === '2',
  )
  await pdfFrame.getByLabel('PDF 页码').fill('1')
  await pdfFrame.getByRole('button', { name: /Saved note body/ }).click()
  await pdfFrame.getByText('Saved note body', { exact: true }).waitFor()
  await pdfFrame.getByText('Saved reply body', { exact: true }).waitFor()
  assert.equal(await pdfFrame.locator('.pdf-note-margin textarea').count(), 0)
  assert.equal(await pdfFrame.locator('.pdf-note-pin svg').count(), 1)
  await tab.screenshot({ path: join(output, 'pdf-note-thread.png') })
  await pdfFrame.getByRole('button', { name: '关闭', exact: true }).click()
  await pdfFrame.getByRole('button', { name: '文档信息', exact: true }).click()
  await pdfFrame.getByText('Title：Viewer Reading Regression', { exact: true }).waitFor()
  await pdfFrame.getByRole('button', { name: '适合页面', exact: true }).click()
  await tab.screenshot({ path: join(output, 'pdf-reading.png') })
  console.log(
    'PDF: thumbnail/heading outline, positioned search, saved note/reply and metadata passed',
  )

  const word = await open(wordPath)
  await word.locator('.pv-page').last().waitFor()
  assert.equal(await word.locator('.pv-page[inert]').count(), 0)
  assert.equal(await word.locator('[contenteditable=true]').count(), 0)
  assert.equal(await word.locator('[role=document]').count(), 1)
  assert.equal(await word.locator('.viewer-doc-a11y a').first().getAttribute('tabindex'), null)
  assert.equal(await word.locator('.pv-content a').first().getAttribute('tabindex'), '-1')
  assert.equal(
    await word.evaluate(() => {
      const paragraph = [...document.querySelectorAll('.pv-content p')].find(
        (p) => p.textContent === 'viewerneedle viewerneedle',
      )
      const range = document.createRange()
      range.selectNodeContents(paragraph)
      const selection = document.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      const clipboardData = new DataTransfer()
      paragraph.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, clipboardData }))
      selection.removeAllRanges()
      return clipboardData.getData('text/plain')
    }),
    'viewerneedle viewerneedle',
  )
  assert.equal(
    await word
      .locator('.pv-page')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    'rgb(255, 244, 219)',
  )
  await word.getByLabel('搜索 Word').fill('viewerneedle')
  await word.getByRole('button', { name: '搜索', exact: true }).click()
  await word.waitForFunction(() =>
    document.querySelector('.viewer-bar').textContent.includes('1/3'),
  )
  assert.equal(await word.evaluate(() => CSS.highlights.get('viewer-doc-search').size), 3)
  await word.getByRole('button', { name: '下一处', exact: true }).click()
  await word.waitForFunction(() =>
    document.querySelector('.viewer-bar').textContent.includes('2/3'),
  )
  await word.getByLabel('Word 页码').fill('1')
  await word.locator('.pv-content a').filter({ hasText: 'Jump to Viewer Beta' }).first().click()
  await word.waitForFunction(() => document.querySelector('[aria-label="Word 页码"]').value === '2')
  await word.getByRole('button', { name: '适合页面', exact: true }).click()
  await word.getByLabel('修订显示').selectOption('final')
  await word.locator('.pv-page').first().waitFor()
  assert.equal(await word.locator('.pv-content .doc-del').first().isVisible(), false)
  await tab.screenshot({ path: join(output, 'word-reading.png') })
  console.log(
    'Word: text-level search, bookmarks, accessible/read-only DOM, page colour and revision mode passed',
  )

  let prompts = 0
  const dialog = async (d) => {
    if (d.type() === 'prompt') await d.accept(++prompts === 1 ? 'wrong' : 'viewer-secret')
    else await d.accept()
  }
  tab.on('dialog', dialog)
  const protectedWord = await open(encryptedPath)
  await protectedWord.locator('.pv-page').first().waitFor({ timeout: 30000 })
  tab.off('dialog', dialog)
  assert.equal(prompts, 2)
  console.log('Word: incorrect password retry passed')

  const mixed = await open(mixedPath)
  await mixed.locator('.pv-page').last().waitFor({ timeout: 30000 })
  assert.equal(await mixed.locator('[role=alert]').count(), 0)
  assert.ok(await mixed.locator('.viewer-doc-canvas .doc-col-block').count())
  assert.equal(
    await mixed
      .locator('.viewer-doc-canvas [data-idx]')
      .filter({ hasText: /^Section A 1:/ })
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--doc-grid-pitch').trim()),
    '18pt',
  )
  assert.equal(
    await mixed
      .locator('.viewer-doc-canvas [data-idx]')
      .filter({ hasText: /^Section B 1:/ })
      .first()
      .evaluate((el) => getComputedStyle(el).getPropertyValue('--doc-grid-pitch').trim()),
    '24pt',
  )
  assert.ok(await mixed.locator('.viewer-doc-canvas .doc-charspace-block').count())
  await tab.screenshot({ path: join(output, 'mixed-columns.png') })
  console.log(
    'Word: mixed unequal columns, section grids/character spacing converge before snapshot',
  )
  const lazy = await open(lazyPath)
  await lazy.locator('.pv-page').last().waitFor({ timeout: 30000 })
  await lazy.waitForFunction(() =>
    [...document.querySelectorAll('.pv-content img[src*="/doc-media/"]')].some(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  )
  assert.equal(await lazy.locator('[src^="genoffice-docx-media:"]').count(), 0)
  console.log('Word: original lazy media placeholders decode through authorized HTTP URLs')

  const corpusCounts = new Map()
  let delayedFonts = 0
  await tab.route('**/assets/*.woff2', async (route) => {
    delayedFonts++
    await new Promise((resolve) => setTimeout(resolve, 500))
    await route.continue()
  })
  for (const name of [
    '08-multi-section-paper',
    '21-continuous-section',
    '22-two-columns',
    '22-two-columns',
  ]) {
    const frame = await open(resolve(root, `apps/docs/tests/pagination-corpus/docx/${name}.docx`))
    await frame.locator('.pv-page').last().waitFor({ timeout: 30000 })
    assert.equal(await frame.locator('[role=alert]').count(), 0)
    await frame.waitForFunction(() => document.fonts.status === 'loaded')
    await frame.waitForTimeout(500)
    const count = await frame.locator('.pv-page').count()
    await frame.waitForTimeout(600)
    assert.equal(await frame.locator('.pv-page').count(), count)
    if (corpusCounts.has(name)) assert.equal(count, corpusCounts.get(name))
    corpusCounts.set(name, count)
    assert.ok(count > 0)
    if (name === '08-multi-section-paper')
      assert.ok(await frame.locator('.viewer-doc-canvas .doc-col-block').count())
    await tab.screenshot({ path: join(output, `${name}.png`) })
    console.log(`Word corpus ${name}: ${count} pages, stable original layout controller`)
  }
  assert.ok(delayedFonts)
  await tab.unroute('**/assets/*.woff2')
  const active = new URL(await tab.locator('iframe').getAttribute('src'), url).searchParams.get(
    'session',
  )
  await tab.waitForTimeout(3500)
  assert.equal((await tab.request.get(`${url}/api/view-sessions/${active}`)).status(), 200)
  await tab.request.delete(`${url}/api/view-sessions/${active}`)
  await tab.getByRole('button', { name: '重新打开', exact: true }).waitFor()
  await tab.getByRole('button', { name: '重新打开', exact: true }).click()
  await tab.locator('iframe').waitFor()
  const recovered = await (await tab.locator('iframe').elementHandle()).contentFrame()
  await recovered.locator('.pv-page').first().waitFor({ timeout: 30000 })
  console.log('Host: active TTL renewal, expired session notice and reopen passed')
  assert.deepEqual(errors, [])
} catch (error) {
  for (const frame of tab?.frames() || [])
    console.error(frame.url(), (await frame.locator('body').innerText()).slice(0, 5000))
  throw error
} finally {
  await browser?.close()
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
}
