import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readZipEntries, bufferSource } from '@genoffice/zip-reader'
import { describe, expect, it } from 'vitest'
import { resolveLimits } from '../src/limits'
import { slimDocxFile } from '../src/docx-slim'
import { writeStoredZip } from '../src/zip-write'

describe('slimDocxFile', () => {
  it('drops media but keeps document.xml and relationships', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'docx-slim-'))
    try {
      const path = join(dir, 'input.docx')
      const bytes = writeStoredZip([
        {
          name: 'word/document.xml',
          data: new TextEncoder().encode(
            '<w:document><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>',
          ),
        },
        {
          name: 'word/_rels/document.xml.rels',
          data: new TextEncoder().encode('<Relationships/>'),
        },
        { name: 'word/media/big.bin', data: new Uint8Array(1024 * 1024) },
      ])
      await writeFile(path, bytes)
      const slim = await slimDocxFile(path, resolveLimits())
      expect(slim.mediaParts.has('word/media/big.bin')).toBe(true)
      expect(slim.removedBytes).toBe(1024 * 1024)
      expect(slim.bytes.length).toBeLessThan(100 * 1024)
      const entries = await readZipEntries(bufferSource(slim.bytes), {
        maxParts: 100,
        maxPartBytes: 1024 * 1024,
        maxTotalBytes: 10 * 1024 * 1024,
      })
      expect(entries.some((entry) => entry.name === 'word/document.xml')).toBe(true)
      expect(entries.some((entry) => entry.name === 'word/media/big.bin')).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
