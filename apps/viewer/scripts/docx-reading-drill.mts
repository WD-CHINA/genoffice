/** DOCX remote reading regression against the running local preview and parse server. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { chromium } from 'playwright-core'

const output = resolve(process.env.WORD_EVIDENCE_DIR ?? '/tmp/genoffice-word-fixes')
await mkdir(output, { recursive: true })
const base = process.env.PARSE_SERVER_URL ?? 'http://127.0.0.1:18787'
const token = process.env.PARSE_SERVER_TOKEN ?? ''
const headers = { Authorization: `Bearer ${token}` }
const root = resolve(import.meta.dirname, '../../..')
const sources = [
  ...[
    '05-long-table',
    '06-with-footnotes',
    '08-multi-section-paper',
    '21-continuous-section',
    '22-two-columns',
    '23-tblheader-repeat',
  ].map((name) => ({
    name,
    path: join(root, 'apps/docs/tests/pagination-corpus/docx', `${name}.docx`),
  })),
]
sources.push({
  name: 'seven-section-headers',
  path: join(
    root,
    'packages/docx-engine/tests/fixtures/truths/render-hf-inline-picture/probe.docx',
  ),
})
if (process.env.WORD_BUSINESS_FILE)
  sources.push({ name: 'business', path: resolve(process.env.WORD_BUSINESS_FILE) })

// Own diagnostic fixture: long paragraph, unequal-height cells, nested table and a vertical merge.
const seed = await JSZip.loadAsync(await readFile(sources[0].path))
const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
const long = p('LONG_START ' + '跨页中文 English text. '.repeat(800) + ' LONG_END')
const cell = (text: string, props = '') =>
  `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/>${props}</w:tcPr>${p(text)}</w:tc>`
const nested = `<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr>${cell('NESTED_ONCE')}</w:tr></w:tbl>`
const table =
  `<w:tbl><w:tblPr><w:tblW w:w="8000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid>` +
  `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell('REPEATED_HEADER')}${cell('SECOND_HEADER')}</w:tr>` +
  `<w:tr><w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/><w:vMerge w:val="restart"/></w:tcPr>${p('MERGE_START ' + '长单元格 '.repeat(700) + ' MERGE_END')}${nested}${p('AFTER_NESTED')}</w:tc>${cell('ROW_ONE')}</w:tr>` +
  `<w:tr>${cell('', '<w:vMerge/>')}${cell('ROW_TWO')}</w:tr></w:tbl>`
const original = await seed.file('word/document.xml')!.async('string')
const sect = original.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)?.[0] ?? ''
seed.file(
  'word/document.xml',
  original.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${long}${table}${p('DOCUMENT_END')}${sect}</w:body>`,
  ),
)
const diagnosticPath = join(output, 'long-and-merged.docx')
await writeFile(diagnosticPath, await seed.generateAsync({ type: 'nodebuffer' }))
sources.push({ name: 'long-and-merged', path: diagnosticPath })
const noteZip = await JSZip.loadAsync(await readFile(sources[1].path))
const noteDoc = await noteZip.file('word/document.xml')!.async('string')
noteZip.file(
  'word/document.xml',
  noteDoc.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body><w:p><w:r><w:t>REFERENCE_LONG_NOTE</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="1"/></w:r></w:p>${p('Body after the note reference. '.repeat(50))}${sect}</w:body>`,
  ),
)
noteZip.file(
  'word/footnotes.xml',
  `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>${'Long footnote 中文 '.repeat(1400)} FOOTNOTE_END</w:t></w:r></w:p></w:footnote></w:footnotes>`,
)
noteZip.file(
  'word/endnotes.xml',
  '<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="1"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t>ENDNOTE_BODY_LAST</w:t></w:r></w:p></w:endnote></w:endnotes>',
)
let rels = await noteZip.file('word/_rels/document.xml.rels')!.async('string')
rels = rels.replace(
  '</Relationships>',
  '<Relationship Id="rIdEndNoteDrill" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/></Relationships>',
)
noteZip.file('word/_rels/document.xml.rels', rels)
noteZip.file(
  '[Content_Types].xml',
  (await noteZip.file('[Content_Types].xml')!.async('string')).replace(
    '</Types>',
    '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/></Types>',
  ),
)
const notePath = join(output, 'long-notes.docx')
await writeFile(notePath, await noteZip.generateAsync({ type: 'nodebuffer' }))
sources.push({ name: 'long-notes', path: notePath })
// Three real chunks exercise the pending NUMPAGES field and the offline cursor API.
const partialZip = await JSZip.loadAsync(await readFile(sources[0].path))
const partialDoc = await partialZip.file('word/document.xml')!.async('string')
const footerSection = sect.replace(
  '<w:sectPr>',
  '<w:sectPr><w:footerReference w:type="default" r:id="rIdPageFooterDrill"/>',
)
partialZip.file(
  'word/document.xml',
  partialDoc.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${Array.from({ length: 420 }, (_, i) => p('CHUNK_PARAGRAPH_' + i)).join('')}${footerSection}</w:body>`,
  ),
)
partialZip.file(
  'word/footer-drill.xml',
  '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>第 </w:t></w:r><w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页 共 </w:t></w:r><w:fldSimple w:instr="NUMPAGES"><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t> 页</w:t></w:r></w:p></w:ftr>',
)
partialZip.file(
  'word/_rels/document.xml.rels',
  (await partialZip.file('word/_rels/document.xml.rels')!.async('string')).replace(
    '</Relationships>',
    '<Relationship Id="rIdPageFooterDrill" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer-drill.xml"/></Relationships>',
  ),
)
partialZip.file(
  '[Content_Types].xml',
  (await partialZip.file('[Content_Types].xml')!.async('string')).replace(
    '</Types>',
    '<Override PartName="/word/footer-drill.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
  ),
)
const partialPath = join(output, 'partial-pages.docx')
await writeFile(partialPath, await partialZip.generateAsync({ type: 'nodebuffer' }))
sources.push({ name: 'partial-pages', path: partialPath })
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const report: any = {
  samples: [],
  scope: 'Actual browser pagination and model fidelity; no independent Office visual baseline',
}
try {
  for (const source of sources.filter(
    (source) => !process.env.WORD_ONLY || source.name === process.env.WORD_ONLY,
  )) {
    const bytes = await readFile(source.path)
    const upload = await fetch(base + '/v1/files', { method: 'POST', headers, body: bytes })
    assert.ok(upload.ok, await upload.clone().text())
    const { fileId } = (await upload.json()) as { fileId: string }
    const sample: any = {
      name: source.name,
      fileId,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      errors: [],
    }
    report.samples.push(sample)
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    await page.addInitScript('globalThis.__name = (fn) => fn')
    page.on('pageerror', (error) => sample.errors.push(error.message))
    try {
      const params = new URLSearchParams({
        parse: 'server',
        server: base,
        fileId,
        token,
        name: source.name,
        theme: 'dark',
      })
      await page.goto('http://127.0.0.1:11019/?' + params)
      const frame = page.frameLocator('iframe')
      await frame.locator('.viewer-doc-remote-page').first().waitFor({ timeout: 120000 })
      const content = page.frames().find((frame) => frame.url().includes('preview.html'))!
      await content.evaluate(async () => {
        await document.fonts.ready
      })
      await page.waitForTimeout(1200)
      sample.start = await content.evaluate(() => ({
        paper: getComputedStyle(document.querySelector('.viewer-doc-remote-page')!).backgroundColor,
        text: document.body.innerText.slice(-1000),
        notes: document.querySelectorAll('[data-note-body]').length,
        fragments: document.querySelectorAll('[data-source-from]').length,
        pages: [...document.querySelectorAll<HTMLElement>('.viewer-doc-remote-page')].map(
          (page) => ({
            index: page.dataset.pageIndex,
            height: page.getBoundingClientRect().height,
            overflow: [...page.querySelectorAll<HTMLElement>('.viewer-doc-remote-column')].some(
              (column) =>
                column.getBoundingClientRect().bottom > page.getBoundingClientRect().bottom + 1,
            ),
          }),
        ),
      }))
      assert.equal(
        sample.start.paper,
        'rgb(255, 255, 255)',
        'Word paper must stay readable in a dark shell',
      )
      sample.pendingPageTotal = await content.evaluate(() =>
        [...document.querySelectorAll('.page-hf')].some((node) => node.textContent?.includes('…')),
      )
      if (source.name === 'partial-pages')
        assert.equal(sample.pendingPageTotal, true, 'partial page totals must be marked pending')
      await page.screenshot({ path: join(output, `${source.name}-first.png`) })
      const visited = new Set<string>()
      const noteIds = new Set<string>()
      for (let step = 0; step < 160; step++) {
        const status = await content.evaluate(() => {
          const viewport = document.querySelector<HTMLElement>('.viewer-doc-remote-viewport')!
          const pages = [...document.querySelectorAll<HTMLElement>('.viewer-doc-remote-page')].map(
            (page) => page.dataset.pageIndex!,
          )
          const notes = [...document.querySelectorAll<HTMLElement>('[data-note-body]')].map(
            (node) => node.dataset.noteBody!,
          )
          const terminal = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 2
          const more = !!document.querySelector(
            '.viewer-doc-remote-more,.viewer-doc-remote-loading',
          )
          viewport.scrollTop = Math.min(viewport.scrollHeight, viewport.scrollTop + 700)
          return { pages, notes, terminal, more }
        })
        status.pages.forEach((id) => visited.add(id))
        status.notes.forEach((id) => noteIds.add(id))
        if (status.terminal && !status.more) break
        await page.waitForTimeout(80)
      }
      sample.visited = visited.size
      sample.noteIds = [...noteIds]
      if (source.name === 'long-notes') {
        assert.ok(visited.size > 2, 'long footnote must continue across physical pages')
        assert.ok(
          await content.locator('[data-note-body][data-note-kind="endnote"]').count(),
          'endnote body must appear at document end',
        )
      }
      sample.notesOverlap = await content.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.viewer-doc-remote-page')].some((page) => {
          const notes = page.querySelector<HTMLElement>('.viewer-doc-remote-notes')
          return (
            notes &&
            [...page.querySelectorAll<HTMLElement>('.viewer-doc-remote-column')].some((column) =>
              [...column.querySelectorAll<HTMLElement>('.viewer-doc-fragment,.doc-page > *')]
                .filter(
                  (element) =>
                    !element.closest('.viewer-doc-fragment') ||
                    element.matches('.viewer-doc-fragment'),
                )
                .some(
                  (element) =>
                    element.getBoundingClientRect().bottom > notes.getBoundingClientRect().top + 1,
                ),
            )
          )
        }),
      )
      assert.equal(sample.notesOverlap, false, 'body must not overlap the reserved footnote area')
      assert.ok(
        sample.start.pages.every((page: any) => !page.overflow),
        'body must not overflow physical pages',
      )
      sample.final = await content.evaluate(() => ({
        alerts: [...document.querySelectorAll('[role=alert]')].map((node) => node.textContent),
        text: document.body.innerText.slice(-1200),
      }))
      if (source.name === 'partial-pages') {
        assert.ok(sample.final.text.includes('CHUNK_PARAGRAPH_419'), 'last chunk must be reached')
        assert.ok(
          !(await content.evaluate(() =>
            [...document.querySelectorAll('.page-hf')].some((node) =>
              node.textContent?.includes('…'),
            ),
          )),
          'complete page total must be resolved',
        )
      }
      assert.equal(sample.errors.length, 0, JSON.stringify(sample.errors))
      assert.equal(sample.final.alerts.length, 0)
      if (source.name === '06-with-footnotes')
        assert.ok(noteIds.size, 'footnote bodies must be rendered')
      sample.status = 'passed'
    } catch (error) {
      sample.status = 'failed'
      sample.error = String(error)
    }
    await page.close()
    await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
    console.log(source.name, sample.status, sample.error ?? '', sample.visited)
  }
} finally {
  await browser.close()
}
assert.ok(
  report.samples.every((sample: any) => sample.status === 'passed'),
  'DOCX browser regression failed',
)
