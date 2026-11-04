import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { scanDocxMetadata } from '../src/docx-metadata'

const FIXTURES = ['table-style-ppr-spacing', 'render-hf-inline-picture']

describe('scanDocxMetadata', () => {
  for (const name of FIXTURES) {
    it(`collects metadata while streaming ${name}`, async () => {
      const path = join(
        process.cwd(),
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
