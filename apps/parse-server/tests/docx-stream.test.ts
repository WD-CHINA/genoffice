import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import JSZip from 'jszip'
import { parseDocx } from '@genoffice/docx-engine'
import { describe, expect, it } from 'vitest'
import { streamDocxBlocks } from '../src/docx-stream'

const FIXTURES = ['render-parity-blank-odd', 'table-style-ppr-spacing', 'render-hf-inline-picture']

async function documentXml(name: string): Promise<Uint8Array> {
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
  const file = zip.file('word/document.xml')
  if (!file) throw new Error(`missing document.xml in ${name}`)
  return file.async('uint8array')
}

describe('streamDocxBlocks', () => {
  for (const name of FIXTURES) {
    it(`matches parseDocx block order for ${name}`, async () => {
      const bytes = await readFile(
        join(
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
      )
      const parsed = await parseDocx(bytes)
      const xml = await documentXml(name)
      // Tiny chunks force tags, attributes and text to cross boundaries.
      const chunks: Uint8Array[] = []
      for (let offset = 0; offset < xml.length; offset += 3) {
        chunks.push(xml.subarray(offset, offset + 3))
      }
      const blocks: Array<{ docxIndex: number; tag: string; xml: string }> = []
      for await (const block of streamDocxBlocks(Readable.from(chunks))) blocks.push(block)
      expect(blocks.map((block) => block.docxIndex)).toEqual(
        parsed.blocks.map((block) => block.docxIndex),
      )
      expect(blocks.every((block) => block.xml.startsWith(`<${block.tag}`))).toBe(true)
    })
  }

  it('keeps the current block across a chunk boundary', async () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>hello</w:t></w:r></w:p></w:body></w:document>'
    const chunks = [...xml].map((char) => new TextEncoder().encode(char))
    const blocks = []
    for await (const block of streamDocxBlocks(Readable.from(chunks))) blocks.push(block)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].tag).toBe('w:p')
    expect(blocks[0].xml).toContain('hello')
  })
})
