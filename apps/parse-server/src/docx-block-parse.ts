import JSZip from 'jszip'
import { parseDocx } from '@genoffice/docx-engine'

/**
 * Gate A spike: parse one streamed top-level block with the real docx engine.
 *
 * The engine's public entry point parses a whole package, so this wraps the
 * slice in the original package (styles/rels/media/numbering/sectPr kept) and
 * runs parseDocx on it. It proves the semantic half; the next step is to
 * expose the engine's block parser with a reusable context instead of
 * regenerating a package per block.
 */
export async function parseDocxBlockSlice(bytes: Uint8Array, blockXml: string): Promise<any> {
  const zip = await JSZip.loadAsync(bytes)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('not a docx: missing word/document.xml')
  const documentXml = await documentFile.async('string')
  const bodyStart = documentXml.indexOf('<w:body>')
  const bodyEnd = documentXml.lastIndexOf('</w:body>')
  if (bodyStart < 0 || bodyEnd < 0) throw new Error('not a docx: missing w:body')
  const body = documentXml.slice(bodyStart + '<w:body>'.length, bodyEnd)
  const sectPr = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(body)?.[0] ?? ''
  zip.file(
    'word/document.xml',
    documentXml.slice(0, bodyStart + '<w:body>'.length) +
      blockXml +
      sectPr +
      documentXml.slice(bodyEnd),
  )
  const parsed = await parseDocx(await zip.generateAsync({ type: 'uint8array' }))
  const block = parsed.blocks[0]
  if (!block) throw new Error('block slice produced no block')
  return block
}
