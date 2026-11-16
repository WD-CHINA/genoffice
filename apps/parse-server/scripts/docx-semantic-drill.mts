/** Compare streamed remote body content with the existing full parser, without copying private samples. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import JSZip from 'jszip'
import { parseDocx, readSections } from '@genoffice/docx-engine'
import { setTimeout as delay } from 'node:timers/promises'

const option = (name: string, fallback = '') => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback)
}
const root = resolve(import.meta.dirname, '../../..')
const files = [
  ...[
    '05-long-table',
    '06-with-footnotes',
    '08-multi-section-paper',
    '21-continuous-section',
    '22-two-columns',
    '23-tblheader-repeat',
  ].map((name) => resolve(root, `apps/docs/tests/pagination-corpus/docx/${name}.docx`)),
  resolve(root, 'packages/docx-engine/tests/fixtures/truths/render-hf-inline-picture/probe.docx'),
]
if (option('input'))
  for (const name of await readdir(option('input'))) {
    if (/\.docx$/i.test(name) && !name.startsWith('.')) files.push(resolve(option('input'), name))
  }
const base = option('url', 'http://127.0.0.1:18787')
const headers = { Authorization: `Bearer ${process.env.PARSE_SERVER_TOKEN ?? ''}` }
async function json(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } })
  const body = (await response.json()) as any
  assert.ok(response.ok, JSON.stringify(body))
  return body
}
function signature(block: any) {
  const text: string[] = []
  const rows: number[] = []
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.text === 'string') text.push(value.text)
    if (Array.isArray(value.rows)) rows.push(value.rows.length)
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) item.forEach(visit)
      else if (item && typeof item === 'object') visit(item)
    }
  }
  visit(block)
  return {
    type: block.type,
    textHash: createHash('sha256').update(JSON.stringify(text)).digest('hex'),
    rows,
  }
}
const report: any = {
  date: new Date().toISOString(),
  samples: [],
  scope:
    'Body block types, recursive run text and table row counts; not rendered pagination or header/footer fidelity',
}
for (const path of files) {
  const sample: any = {
    name: path.startsWith(root + '/') ? path.slice(root.length + 1) : basename(path),
    status: 'running',
  }
  report.samples.push(sample)
  try {
    const bytes = await readFile(path)
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    sample.sourceSections = (xml.match(/<w:sectPr\b/g) ?? []).length
    // Office also uses names such as footer.xml, not only footer1.xml.
    const relationships = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? ''
    sample.sourceHeadersFooters = (
      relationships.match(/<Relationship\b[^>]*\bType=["'][^"']+\/(?:header|footer)["'][^>]*>/g) ??
      []
    ).length
    const full = await parseDocx(bytes)
    const upload = await json('/v1/files', { method: 'POST', body: bytes })
    sample.fileId = upload.fileId
    const opened = await json('/v1/sessions', {
      method: 'POST',
      headers: { ...{ 'Content-Type': 'application/json' }, Prefer: 'respond-async' },
      body: JSON.stringify({ fileId: upload.fileId }),
    })
    const deadline = Date.now() + 60_000
    for (;;) {
      const status = await json(`/v1/sessions/${opened.sessionId}`)
      if (status.state === 'ready') break
      assert.ok(status.state !== 'failed' && Date.now() < deadline, JSON.stringify(status))
      await delay(100)
    }
    const document = await json(`/v1/sessions/${opened.sessionId}/document`)
    sample.unitCount = document.model.unitCount
    const blocks: any[] = []
    for (let index = 0; index < document.model.unitCount; index++) {
      blocks.push(
        ...(await json(`/v1/sessions/${opened.sessionId}/units/${index}?representation=model`))
          .blocks,
      )
    }
    sample.fullBlockCount = full.blocks.length
    sample.remoteBlockCount = blocks.length
    sample.bodyEquivalent =
      JSON.stringify(full.blocks.map(signature)) === JSON.stringify(blocks.map(signature))
    sample.remotePageSettings = document.model.page
    const reading = document.model.docx
    sample.remoteModelHasSections = Array.isArray(reading?.sections)
    sample.remoteModelHasHeadersFooters = Boolean(
      reading?.hfParts && Object.keys(reading.hfParts).length,
    )
    assert.ok(reading, 'missing DOCX reading context')
    assert.deepEqual(reading.sections, readSections(full), 'section ranges/settings differ')
    assert.deepEqual(reading.noteNumbers, full.noteNumbers, 'note numbering map differs')
    assert.deepEqual(
      reading.footnoteProps,
      full.footnoteProps,
      'footnote number formatting differs',
    )
    assert.deepEqual(reading.endnoteProps, full.endnoteProps, 'endnote number formatting differs')
    sample.sectionCount = reading.sections.length
    sample.headerFooterParts = Object.keys(reading.hfParts).length
    for (const [id, part] of Object.entries(full.hfParts ?? {})) {
      assert.equal(reading.hfParts[id]?.text, part.text, `header/footer ${id} text differs`)
      assert.equal(
        reading.hfParts[id]?.images?.length ?? 0,
        part.images?.length ?? 0,
        `header/footer ${id} images differ`,
      )
    }
    assert.equal(sample.bodyEquivalent, true, 'body content/type/table rows differ')
    sample.status = 'passed'
    await fetch(`${base}/v1/sessions/${opened.sessionId}`, { method: 'DELETE', headers })
  } catch (error) {
    sample.status = 'failed'
    sample.error = String(error)
  }
  console.log(JSON.stringify(sample))
}
report.status = report.samples.every((sample: any) => sample.status === 'passed')
  ? 'passed'
  : 'failed'
await writeFile(
  option('out', '/tmp/genoffice-docx-semantics.json'),
  JSON.stringify(report, null, 2),
)
if (report.status === 'failed') process.exitCode = 1
