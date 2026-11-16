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
// Different line pitches must advance independently; completed cells align once.
const flowZip = await JSZip.loadAsync(await readFile(sources[0].path))
const flowCell = (text: string, align = 'top', pitch = 300) =>
  `<w:tc><w:tcPr><w:tcW w:w="2100" w:type="dxa"/><w:vAlign w:val="${align}"/></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="${pitch}" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr>${text}</w:r></w:p></w:tc>`
const flowLines = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, i) => `<w:t>${prefix}_${String(i).padStart(3, '0')}</w:t>${i < count - 1 ? '<w:br/>' : ''}`,
  ).join('')
flowZip.file(
  'word/document.xml',
  original.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${p('FLOW_PREFIX '.repeat(160))}<w:tbl><w:tblPr><w:tblW w:w="8400" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="2100"/>'.repeat(4)}</w:tblGrid><w:tr>${flowCell(flowLines('FLOW_A', 75))}${flowCell(flowLines('FLOW_B', 61), 'top', 375)}${flowCell('<w:t>FLOW_MIDDLE</w:t>', 'center')}${flowCell('<w:t>FLOW_BOTTOM</w:t>', 'bottom')}</w:tr></w:tbl>${p('FLOW_DOCUMENT_END')}${sect}</w:body>`,
  ),
)
const flowPath = join(output, 'independent-cells.docx')
await writeFile(flowPath, await flowZip.generateAsync({ type: 'nodebuffer' }))
sources.push({ name: 'independent-cells', path: flowPath })

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
// A fractional text width plus rounded fixed columns used to clip the outer right border.
const edgeZip = await JSZip.loadAsync(await readFile(sources[0].path))
const edgeDocument = await edgeZip.file('word/document.xml')!.async('string')
const edgeTable = `<w:tbl><w:tblPr><w:tblW w:w="9027" w:type="dxa"/><w:tblInd w:w="115" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:color="000000"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol w:w="564"/>'.repeat(16)}</w:tblGrid>${[0, 1].map((row) => `<w:tr>${Array.from({ length: 8 }, (_, col) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/><w:gridSpan w:val="2"/></w:tcPr>${p(row === 1 && col === 0 ? '跨页文字 '.repeat(100) : `CELL_${row}_${col}`)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`
edgeZip.file(
  'word/document.xml',
  edgeDocument.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${p('TABLE_RIGHT_EDGE')}${edgeTable}${sect}</w:body>`,
  ),
)
const edgePath = join(output, 'table-right-edge.docx')
await writeFile(edgePath, await edgeZip.generateAsync({ type: 'nodebuffer' }))
sources.push({ name: 'table-right-edge', path: edgePath })
for (const variant of ['borderless', 'styled'] as const) {
  const zip = await JSZip.loadAsync(await readFile(edgePath))
  const xml = await zip.file('word/document.xml')!.async('string')
  zip.file(
    'word/document.xml',
    variant === 'borderless'
      ? xml.replaceAll('w:val="single"', 'w:val="nil"')
      : xml
          .replaceAll('w:val="single"', 'w:val="double"')
          .replaceAll('w:color="000000"', 'w:color="336699"'),
  )
  const path = join(output, `table-${variant}.docx`)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  sources.push({ name: `table-${variant}`, path })
}
const typographyZip = await JSZip.loadAsync(await readFile(sources[0].path))
typographyZip.file(
  'word/styles.xml',
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/><w:sz w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Base"><w:name w:val="Base"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="28"/><w:color w:val="123456"/></w:rPr><w:pPr><w:spacing w:after="180" w:line="360" w:lineRule="exact"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Base"/></w:style></w:styles>`,
)
typographyZip.file(
  'word/document.xml',
  original.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body>${p('DEFAULT_BASELINE 中文')}<w:p><w:pPr><w:pStyle w:val="Derived"/></w:pPr><w:r><w:t>NAMED_OVERRIDE 中文</w:t></w:r></w:p>${sect}</w:body>`,
  ),
)
const typographyPath = join(output, 'typography-defaults.docx')
await writeFile(typographyPath, await typographyZip.generateAsync({ type: 'nodebuffer' }))
sources.push({ name: 'typography-defaults', path: typographyPath })
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
})
const report: any = {
  samples: [],
  scope:
    'Continuous reading, bounded source windows and model fidelity; no independent Office visual baseline',
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
        format: 'docx',
        src: 'remote',
        server: base,
        fileId,
        token,
        name: source.name,
        theme: 'dark',
      })
      await page.goto(
        (process.env.WORD_VIEWER_URL ?? 'http://127.0.0.1:11001').replace(/\/$/, '') +
          '/preview.html?' +
          params,
      )
      await page.locator('.viewer-doc-reading-unit .doc-page').first().waitFor({ timeout: 120000 })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      sample.typography = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.viewer-doc-remote')!
        const editor = root.querySelector('.doc-page')!
        const chinese = root.querySelector('.doc-east-asian-font')
        return {
          sheets: document.querySelectorAll('[data-docx-style-context]').length,
          fallback: root.dataset.docxThemeFallback,
          baseSize: getComputedStyle(editor).fontSize,
          chineseFont: chinese && getComputedStyle(chinese).fontFamily,
          themeLoaded: [...document.fonts].some(
            (face) => face.family.includes('GenOffice Theme Sans SC') && face.status === 'loaded',
          ),
        }
      })
      assert.equal(sample.typography.sheets, 1, 'one document must own one shared style sheet')
      if (source.name === 'business') {
        assert.equal(sample.typography.fallback, 'bundled')
        assert.equal(
          sample.typography.themeLoaded,
          true,
          'the actual fallback face must finish loading before reading',
        )
        assert.match(sample.typography.chineseFont, /GenOffice Theme Sans SC/)
      }
      if (source.name === 'typography-defaults') {
        sample.inheritedStyle = await page.evaluate(() => {
          const ps = [...document.querySelectorAll('.viewer-doc-reading-unit p')]
          const css = (text: string) => {
            const node = ps.find((p) => p.textContent?.includes(text))!,
              style = getComputedStyle(node)
            return {
              size: parseFloat(style.fontSize),
              color: style.color,
              line: parseFloat(style.lineHeight),
              after: parseFloat(style.marginBottom),
            }
          }
          return { base: css('DEFAULT_BASELINE'), named: css('NAMED_OVERRIDE') }
        })
        assert.equal(
          sample.inheritedStyle.base.size,
          16,
          'default font size must reach unstyled paragraphs',
        )
        assert.ok(
          Math.abs(sample.inheritedStyle.named.size - 28 / 1.5) < 0.01,
          'basedOn style size must reach descendants',
        )
        assert.equal(sample.inheritedStyle.named.color, 'rgb(18, 52, 86)')
        assert.equal(
          sample.inheritedStyle.named.line,
          24,
          'exact line height must survive style inheritance',
        )
        assert.equal(
          sample.inheritedStyle.named.after,
          12,
          'style paragraph spacing must reach descendants',
        )
      }
      const units = new Map<string, string>()
      const notes = new Set<string>()
      let finished = false
      for (let step = 0; step < 1200; step++) {
        const state = await page.evaluate(() => {
          const root = document.querySelector('.viewer-doc-reading')!
          const scroll = root.querySelector<HTMLElement>('.viewer-doc-reading-scroll')!
          return {
            paper: getComputedStyle(root.querySelector('.viewer-doc-reading-paper')!)
              .backgroundColor,
            pages: root.querySelectorAll('.pv-page,.viewer-doc-remote-page,[data-source-from]')
              .length,
            editable: root.querySelectorAll('[contenteditable="true"],.doc-content-editing').length,
            counters: root.querySelectorAll('.viewer-page-controls').length,
            units: [...root.querySelectorAll<HTMLElement>('[data-unit-id]')].map(
              (unit) => [unit.dataset.unitId!, unit.textContent ?? ''] as const,
            ),
            notes: [...root.querySelectorAll<HTMLElement>('[data-note-body]')].map(
              (note) => `${note.dataset.noteKind}:${note.dataset.noteBody}`,
            ),
            broken: [...root.querySelectorAll<HTMLImageElement>('img[src]')].filter(
              (image) => image.complete && !image.naturalWidth,
            ).length,
            atEnd: scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2,
            busy:
              !!root.querySelector('[role="status"]') ||
              !!root.querySelector('.viewer-doc-remote-loading'),
            more: !!root.querySelector('.viewer-doc-remote-more'),
            alerts: [...root.querySelectorAll('[role="alert"]')].map((node) => node.textContent),
          }
        })
        assert.equal(state.paper, 'rgb(255, 255, 255)')
        assert.equal(
          state.pages,
          0,
          'continuous reading must never create paper pages or table slices',
        )
        assert.equal(state.editable, 0)
        assert.equal(state.counters, 0)
        assert.equal(state.broken, 0)
        assert.deepEqual(state.alerts, [])
        for (const [id, text] of state.units) units.set(id, text)
        for (const id of state.notes) notes.add(id)
        if (state.atEnd && !state.busy && !state.more) {
          finished = true
          break
        }
        await page
          .locator('.viewer-doc-reading-scroll')
          .evaluate((element) => element.scrollBy(0, element.clientHeight * 0.75))
        await page.waitForTimeout(200)
      }
      assert.equal(finished, true, 'reading must reach the final source unit')
      const text = [...units.values()].join('')
      if (source.name === 'partial-pages') assert.ok(text.includes('CHUNK_PARAGRAPH_419'))
      if (source.name === 'long-and-merged')
        for (const marker of ['LONG_START', 'LONG_END', 'MERGE_START', 'MERGE_END', 'DOCUMENT_END'])
          assert.ok(text.includes(marker), marker)
      if (source.name === '06-with-footnotes')
        assert.ok(notes.size, 'footnotes must remain visible at the end')
      assert.deepEqual(sample.errors, [])
      assert.equal(
        createHash('sha256')
          .update(await readFile(source.path))
          .digest('hex'),
        sample.sha256,
      )
      await page.screenshot({ path: join(output, `${source.name}-continuous.png`) })
      sample.units = units.size
      sample.notes = notes.size
      sample.status = 'passed'
    } catch (error) {
      sample.status = 'failed'
      sample.error = String(error)
    }
    await page.close()
    await writeFile(join(output, 'browser-report.json'), JSON.stringify(report, null, 2))
    console.log(source.name, sample.status, sample.error ?? '')
  }
} finally {
  await browser.close()
}
assert.ok(
  report.samples.every((sample: any) => sample.status === 'passed'),
  'DOCX continuous reading regression failed',
)
