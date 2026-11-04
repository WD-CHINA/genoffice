import { createReadStream } from 'node:fs'
import { createInflateRaw } from 'node:zlib'
import type { Readable } from 'node:stream'
import { readZipEntries, type ZipEntry } from '@genoffice/zip-reader'
import { withFileSource } from './file-source'
import type { ServerLimits } from './limits'

export interface DocxBlockSlice {
  /** Index of the top-level <w:body> child in the original document.xml. */
  docxIndex: number
  /** Raw tag name, e.g. w:p, w:tbl, w:sectPr. */
  tag: string
  /** Exact XML slice, including the element itself. */
  xml: string
  /** Absolute byte offset of the slice in document.xml. */
  start: number
  /** Absolute end offset (exclusive). */
  end: number
}

type Chunk = string | Uint8Array

/**
 * Streaming top-level block splitter for word/document.xml.
 *
 * The scanner keeps only the current block plus a small read-ahead buffer; it
 * never materializes the whole document.xml. It is intentionally format-level
 * (raw slices), so the normal docx parser can consume each block later.
 */
export async function* streamDocxBlocks(
  input: AsyncIterable<Chunk> | Readable,
): AsyncGenerator<DocxBlockSlice> {
  const decoder = new TextDecoder()
  let buffer = ''
  let base = 0
  let scan = 0
  let depth = 0
  let bodyDepth = -1
  let captureStart = -1
  let captureDepth = -1
  let blockIndex = 0

  const emit = (end: number): DocxBlockSlice | null => {
    if (captureStart < 0) return null
    const startInBuffer = captureStart - base
    const endInBuffer = end - base
    const xml = buffer.slice(startInBuffer, endInBuffer)
    const tag = /^<([^\s/>]+)/.exec(xml)?.[1] ?? ''
    const block = { docxIndex: blockIndex++, tag, xml, start: captureStart, end }
    captureStart = -1
    captureDepth = -1
    return block
  }

  for await (const chunk of input) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    while (true) {
      const lt = buffer.indexOf('<', scan)
      if (lt < 0) break
      // Comments / CDATA / processing instructions / doctype.
      if (buffer.startsWith('<!--', lt)) {
        const end = buffer.indexOf('-->', lt + 4)
        if (end < 0) break
        scan = end + 3
        continue
      }
      if (buffer.startsWith('<![CDATA[', lt)) {
        const end = buffer.indexOf(']]>', lt + 9)
        if (end < 0) break
        scan = end + 3
        continue
      }
      if (buffer.startsWith('<?', lt)) {
        const end = buffer.indexOf('?>', lt + 2)
        if (end < 0) break
        scan = end + 2
        continue
      }
      if (buffer.startsWith('<!', lt)) {
        const end = buffer.indexOf('>', lt + 2)
        if (end < 0) break
        scan = end + 1
        continue
      }
      // Find the end of the tag, quote-aware.
      let end = lt + 1
      let quote = ''
      while (end < buffer.length) {
        const char = buffer[end]
        if (quote) {
          if (char === quote) quote = ''
        } else if (char === '"' || char === "'") quote = char
        else if (char === '>') break
        end++
      }
      if (end >= buffer.length) break
      const closing = buffer[lt + 1] === '/'
      const selfClosing = !closing && buffer[end - 1] === '/'
      const name = closing
        ? buffer.slice(lt + 2, end).trim()
        : (/^<([^\s/>]+)/.exec(buffer.slice(lt, end + 1))?.[1] ?? '')
      scan = end + 1
      if (closing) {
        depth--
        if (captureDepth > 0 && depth < captureDepth) {
          const block = emit(scan)
          if (block) yield block
        }
        if (bodyDepth >= 0 && depth < bodyDepth) bodyDepth = -1
        continue
      }
      depth++
      if (name === 'w:body') bodyDepth = depth
      if (bodyDepth >= 0 && depth === bodyDepth + 1 && captureStart < 0) {
        captureStart = base + lt
        captureDepth = depth
      }
      if (selfClosing) {
        depth--
        if (captureDepth > 0 && depth < captureDepth) {
          const block = emit(scan)
          if (block) yield block
        }
      }
    }
    // Drop consumed bytes, but never while a block is being captured.
    if (captureStart < 0 && scan > 64 * 1024) {
      buffer = buffer.slice(scan)
      base += scan
      scan = 0
    }
  }
  buffer += decoder.decode()
  if (captureStart >= 0) {
    const block = emit(base + buffer.length)
    if (block) yield block
  }
}

/** Open word/document.xml as a stream straight from the docx zip entry. */
export async function openDocxDocumentStream(
  path: string,
  limits: ServerLimits,
): Promise<Readable> {
  let found: ZipEntry | null = null
  await withFileSource(path, async (source) => {
    const entries = await readZipEntries(source, {
      maxParts: limits.maxParts,
      maxPartBytes: limits.maxPartBytes,
      maxTotalBytes: limits.maxTotalUncompressedBytes,
    })
    found = entries.find((item) => item.name === 'word/document.xml') ?? null
  })
  const entry = found as ZipEntry | null
  if (!entry) throw new Error('not a docx: missing word/document.xml')
  const compressed = createReadStream(path, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.csize - 1,
  })
  if (entry.method === 0) return compressed
  if (entry.method === 8) return compressed.pipe(createInflateRaw())
  compressed.destroy()
  throw new Error(`unsupported zip compression method ${entry.method}`)
}
