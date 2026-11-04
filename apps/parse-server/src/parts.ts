import { createReadStream, type ReadStream } from 'node:fs'
import { createInflateRaw, inflateRawSync } from 'node:zlib'
import type { Readable } from 'node:stream'
import { readZipEntries, type ZipEntry } from '@genoffice/zip-reader'
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

export interface PartStream {
  stream: Readable
  mime: string
  size: number
  contentLength: number
  ranged: boolean
  range?: { start: number; end: number }
}

export type PartStreamResult = PartStream | { invalidRange: true; size: number }

async function partEntry(
  path: string,
  partPath: string,
  limits: ServerLimits,
): Promise<ZipEntry | null> {
  if (!partPath || partPath.includes('\0')) return null
  return withFileSource(path, async (source) => {
    const entries = await readZipEntries(source, {
      maxParts: limits.maxParts,
      maxPartBytes: limits.maxPartBytes,
      maxTotalBytes: limits.maxTotalUncompressedBytes,
    })
    return entries.find((item) => item.name === partPath && !item.name.endsWith('/')) ?? null
  })
}

/**
 * Open one OOXML part as a stream.
 *
 * Stored (method 0) parts are sliced straight from the file, so Range and HEAD
 * cost a read of the requested bytes only. Deflated parts are inflated through
 * a stream; a Range request on those falls back to a full 200 response.
 */
export async function openFilePart(
  path: string,
  partPath: string,
  limits: ServerLimits,
  rangeHeader?: string,
): Promise<PartStreamResult | null> {
  const entry = await partEntry(path, partPath, limits)
  if (!entry || entry.usize > limits.maxPartBytes) return null
  const mime = mimeForPart(partPath)
  const range = rangeHeader ? parseRange(rangeHeader, entry.usize) : null
  if (range === 'invalid') return { invalidRange: true, size: entry.usize }
  if (range && entry.method === 0) {
    const start = entry.dataOffset + range.start
    const end = entry.dataOffset + range.end
    return {
      stream: createReadStream(path, { start, end }),
      mime,
      size: entry.usize,
      contentLength: range.end - range.start + 1,
      ranged: true,
      range,
    }
  }
  const compressed: ReadStream = createReadStream(path, {
    start: entry.dataOffset,
    end: entry.dataOffset + entry.csize - 1,
  })
  if (entry.method === 0) {
    return {
      stream: compressed,
      mime,
      size: entry.usize,
      contentLength: entry.usize,
      ranged: false,
    }
  }
  if (entry.method === 8) {
    return {
      stream: compressed.pipe(createInflateRaw()),
      mime,
      size: entry.usize,
      contentLength: entry.usize,
      ranged: false,
    }
  }
  compressed.destroy()
  return null
}

/**
 * Buffered helper for small parts and tests. The HTTP route uses
 * `openFilePart` so large media never lands in a single Buffer.
 */
export async function readFilePart(
  path: string,
  partPath: string,
  limits: ServerLimits,
  rangeHeader?: string,
): Promise<FilePartResult | null> {
  const opened = await openFilePart(path, partPath, limits, rangeHeader)
  if (!opened) return null
  if ('invalidRange' in opened) return opened
  const chunks: Buffer[] = []
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return {
    bytes: Buffer.concat(chunks),
    mime: opened.mime,
    size: opened.size,
    ranged: opened.ranged,
    ...(opened.range ? { range: opened.range } : {}),
  }
}

/** Kept for callers that need a synchronous decompress of a known entry. */
export function inflatePart(bytes: Uint8Array, size: number): Buffer {
  return inflateRawSync(bytes, { maxOutputLength: Math.max(1, size) })
}
