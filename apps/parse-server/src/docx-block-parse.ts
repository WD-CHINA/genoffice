import { createDocxBlockParser } from '@genoffice/docx-engine'
import type { DocxBlockSlice } from './docx-stream'

/**
 * Gate A.2: parse streamed block slices with one reusable docx parser context.
 * The package context (styles, numbering, rels, theme, notes, sections, media)
 * is built once; blocks no longer repackage the document one at a time.
 */
export async function parseDocxBlockSlices(
  bytes: Uint8Array,
  slices: readonly DocxBlockSlice[],
): Promise<any[]> {
  const parser = await createDocxBlockParser(bytes)
  const blocks = []
  for (let index = 0; index < slices.length; index++) {
    blocks.push(await parser.parseBlock(slices[index].xml, index))
  }
  return blocks
}
