import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import JSZip from 'jszip'
import { parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { streamDocxBlocks } from '../src/docx-stream'
import { parseDocxBlockSlices } from '../src/docx-block-parse'

const FIXTURES = ['table-style-ppr-spacing', 'render-hf-inline-picture']
const VIEWER_FIXTURE = ['..', 'viewer', 'src', 'web', 'public', 'docx-spike-table.docx']

function textOf(block: any): string {
  return (block.runs || []).map((run: any) => run.text || '').join('')
}

describe('parseDocxBlockSlices', () => {
  const paths = [
    ...FIXTURES.map((name) => ({
      name,
      path: join(
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
      ),
    })),
    {
      name: 'docx-spike-table (revisions/footnotes/table)',
      path: join(process.cwd(), ...VIEWER_FIXTURE),
    },
  ]
  for (const { name, path } of paths) {
    it(`matches the full parser for ${name}`, async () => {
      const bytes = await readFile(path)
      const zip = await JSZip.loadAsync(bytes)
      const documentXml = await zip.file('word/document.xml')!.async('string')
      const slices = []
      for await (const slice of streamDocxBlocks(Readable.from([documentXml]))) slices.push(slice)
      const full = await parseDocx(bytes)
      expect(slices).toHaveLength(full.blocks.length)
      const blocks = await parseDocxBlockSlices(bytes, slices)
      for (let index = 0; index < slices.length; index++) {
        expect(blocks[index].type).toBe(full.blocks[index].type)
        expect(textOf(blocks[index])).toBe(textOf(full.blocks[index]))
        expect(blocks[index].table?.rows.length ?? 0).toBe(
          full.blocks[index].table?.rows.length ?? 0,
        )
      }
    })
  }
})
