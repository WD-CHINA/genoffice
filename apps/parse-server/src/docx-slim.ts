import { inflateRawSync } from 'node:zlib'
import { readZipEntries, type ByteSource, type ZipEntry } from '@genoffice/zip-reader'
import { withFileSource } from './file-source'
import type { ServerLimits } from './limits'
import { ParseLimitError } from './pptx-slim'
import { writeStoredZip, type StoredZipEntry } from './zip-write'

export interface SlimDocx {
  /** Stored-only zip with non-media parts; small enough for the worker parser. */
  bytes: Buffer
  /** Media parts left in the original file; served by the parts route. */
  mediaParts: Set<string>
  removedBytes: number
}

function isMediaPart(name: string): boolean {
  return name.startsWith('word/media/') || name.startsWith('word/embeddings/')
}

async function readEntry(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  const raw = await source.read(entry.dataOffset, entry.csize)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.usize) })
  }
  throw new Error(`docx: unsupported compression method ${entry.method} for ${entry.name}`)
}

/**
 * Build a parser input without media/embeddings. A 1 GB DOCX is usually mostly
 * media; the slim archive keeps the worker memory bounded while the original
 * parts remain available through `GET /v1/files/:id/parts/...`.
 */
export async function slimDocxFile(
  path: string,
  limits: ServerLimits,
  options: { omitDocument?: boolean } = {},
): Promise<SlimDocx> {
  return withFileSource(path, async (source) => {
    const entries = await readZipEntries(source, {
      maxParts: limits.maxParts,
      maxPartBytes: limits.maxPartBytes,
      maxTotalBytes: limits.maxTotalUncompressedBytes,
    })
    const kept: StoredZipEntry[] = []
    const mediaParts = new Set<string>()
    let removedBytes = 0
    let slimBytes = 0
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue
      if (isMediaPart(entry.name)) {
        mediaParts.add(entry.name)
        removedBytes += entry.usize
        continue
      }
      const omit = options.omitDocument && entry.name === 'word/document.xml'
      if (!omit && slimBytes + entry.usize > limits.maxParseBytes)
        throw new ParseLimitError(limits.maxParseBytes)
      const data = omit
        ? Buffer.from(
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
          )
        : await readEntry(source, entry)
      kept.push({ name: entry.name, data })
      slimBytes += data.length
      if (slimBytes > limits.maxParseBytes) throw new ParseLimitError(limits.maxParseBytes)
    }
    return { bytes: writeStoredZip(kept), mediaParts, removedBytes }
  })
}
