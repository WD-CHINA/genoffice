import { serverRoot } from './helpers/paths'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { scanDocxMetadata } from '../src/docx-metadata'

const FIXTURES = ['table-style-ppr-spacing', 'render-hf-inline-picture']

describe('scanDocxMetadata', () => {
  it('keeps a reference skeleton and source section indices without retaining paragraph text', async () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>private text</w:t><w:footnoteReference w:id="9"/></w:r></w:p>' +
      '<w:p><w:pPr><w:sectPr><w:type w:val="continuous"/></w:sectPr></w:pPr></w:p>' +
      '<w:p><w:r><w:endnoteReference w:id="2"/></w:r></w:p></w:body></w:document>'
    const result = await scanDocxMetadata(Readable.from([...xml]))
    expect(result.sections[0].docxIndex).toBe(1)
    expect(result.noteReferenceXml).toContain('<w:footnoteReference w:id="9"/>')
    expect(result.noteReferenceXml).toContain('<w:endnoteReference w:id="2"/>')
    expect(result.noteReferenceXml).not.toContain('private text')
  })
  for (const name of FIXTURES) {
    it(`collects metadata while streaming ${name}`, async () => {
      const path = join(
        serverRoot,
        '..',
        '..',
        'packages',
        'docx-engine',
        'tests',
        'fixtures',
        'truths',
        name,
        'probe.docx',
      )
      const zip = await JSZip.loadAsync(await readFile(path))
      const xml = await zip.file('word/document.xml')!.async('uint8array')
      const chunks: Uint8Array[] = []
      for (let offset = 0; offset < xml.length; offset += 3) {
        chunks.push(xml.subarray(offset, offset + 3))
      }
      const metadata = await scanDocxMetadata(Readable.from(chunks))
      const text = new TextDecoder().decode(xml)
      expect(metadata.blockCount).toBeGreaterThan(0)
      expect(metadata.sectionCount).toBe((text.match(/<w:sectPr\b/g) || []).length)
      expect(metadata.commentRangeCount).toBe((text.match(/<w:commentRangeStart\b/g) || []).length)
      expect(metadata.hasPageBreak).toBe(
        /<w:br [^>]*w:type="page"|<w:pageBreakBefore\b|<w:lastRenderedPageBreak\b/.test(text),
      )
    })
  }
})
