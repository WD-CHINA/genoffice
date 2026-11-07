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

it('rejects oversized individual blocks and incomplete XML instead of publishing partial content', async () => {
  const consume = async (xml: string, limit = 1000) => {
    for await (const _block of streamDocxBlocks(Readable.from([xml]), limit)) {
      /* consume */
    }
  }
  await expect(
    consume('<w:document><w:body><w:p>' + 'x'.repeat(200) + '</w:p></w:body></w:document>', 100),
  ).rejects.toMatchObject({ code: 'parse_limit' })
  await expect(consume('<w:document><w:body><w:p>unfinished')).rejects.toThrow('incomplete element')
})

it('preserves every Unicode block and absolute offsets after compacting the 64 KiB buffer', async () => {
  const paragraphs = Array.from(
    { length: 400 },
    (_, index) => `<w:p><w:r><w:t>${index}:${'中文'.repeat(180)}</w:t></w:r></w:p>`,
  )
  const xml = '<w:document><w:body>' + paragraphs.join('') + '</w:body></w:document>'
  const bytes = Buffer.from(xml)
  async function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += 4093)
      yield bytes.subarray(offset, offset + 4093)
  }
  let index = 0
  for await (const block of streamDocxBlocks(chunks())) {
    expect(block.xml).toBe(paragraphs[index++])
    expect(xml.slice(block.start, block.end)).toBe(block.xml)
  }
  expect(index).toBe(paragraphs.length)
})
