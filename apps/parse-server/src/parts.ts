import { inflateRawSync } from 'node:zlib'
import { readZipEntries } from '@genoffice/zip-reader'
import { withFileSource } from './file-source'
import type { ServerLimits } from './limits'
import { mimeForPart } from './mime'
import { parseRange } from './range'

export interface FilePart {
  bytes: Buffer
  mime: string
  size: number
  ranged: boolean
  range?: { start: number; end: number }
}

export type FilePartResult = FilePart | { invalidRange: true; size: number }

/**
 * Read one entry from a stored document by name. Stored (uncompressed) parts
 * can be sliced directly; deflated parts must be inflated whole, so a Range
 * request on those falls back to a full 200 response.
 */
export async function readFilePart(
  path: string,
  partPath: string,
  limits: ServerLimits,
  rangeHeader?: string,
): Promise<FilePartResult | null> {
  if (!partPath || partPath.includes('\0')) return null
  return withFileSource(path, async (source) => {
    const entries = await readZipEntries(source, {
      maxParts: limits.maxParts,
      maxPartBytes: limits.maxPartBytes,
      maxTotalBytes: limits.maxTotalUncompressedBytes,
    })
    const entry = entries.find((item) => item.name === partPath && !item.name.endsWith('/'))
    if (!entry) return null
    if (entry.usize > limits.maxPartBytes) return null
    const mime = mimeForPart(partPath)
    const range = rangeHeader ? parseRange(rangeHeader, entry.usize) : null
    if (range === 'invalid') return { invalidRange: true, size: entry.usize }
    if (range && entry.method === 0) {
      const raw = await source.read(entry.dataOffset + range.start, range.end - range.start + 1)
      return {
        bytes: Buffer.from(raw),
        mime,
        size: entry.usize,
        ranged: true,
        range,
      }
    }
    const raw = await source.read(entry.dataOffset, entry.csize)
    const bytes =
      entry.method === 0
        ? Buffer.from(raw)
        : entry.method === 8
          ? inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.usize) })
          : null
    if (!bytes) return null
    return { bytes, mime, size: entry.usize, ranged: false }
  })
}
