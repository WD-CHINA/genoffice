import { inflateRawSync } from 'node:zlib'
import { readZipEntries, type ByteSource, type ZipEntry } from '@genoffice/zip-reader'
import { withFileSource } from './file-source'
import type { ServerLimits } from './limits'
import { writeStoredZip, type StoredZipEntry } from './zip-write'

/** The slim archive exceeded the in-process parser budget. */
export class ParseLimitError extends Error {
  readonly code = 'parse_limit'
  constructor(readonly limit: number) {
    super(`slim presentation exceeds the ${limit}-byte parse limit`)
    this.name = 'ParseLimitError'
  }
}

export interface SlimPptx {
  /** A stored-only zip with the non-media parts; small enough to open in memory. */
  bytes: Buffer
  /** Media parts left on disk; the parts route serves them by name. */
  mediaParts: Set<string>
  removedBytes: number
}

function isMediaPart(name: string): boolean {
  // Electron transforms these before display. Keep them in the bounded parser
  // archive so the same resolver can decode TIFF and retint SVG per slide.
  return name.startsWith('ppt/media/') && !/\.(?:tiff?|svg)$/i.test(name)
}

async function readEntry(source: ByteSource, entry: ZipEntry): Promise<Uint8Array> {
  const raw = await source.read(entry.dataOffset, entry.csize)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.usize) })
  }
  throw new Error(`pptx: unsupported compression method ${entry.method} for ${entry.name}`)
}

/**
 * Build the parser's input by copying every non-media part into a stored-only
 * zip. Media (the bulk of a 1 GB deck) stays on disk and is served by
 * `GET /v1/files/:id/parts/:partPath`, so `openPptx` never inflates it.
 */
export async function slimPptxFile(path: string, limits: ServerLimits): Promise<SlimPptx> {
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
      const data = await readEntry(source, entry)
      kept.push({ name: entry.name, data })
      slimBytes += data.length
      if (slimBytes > limits.maxParseBytes) throw new ParseLimitError(limits.maxParseBytes)
    }
    return { bytes: writeStoredZip(kept), mediaParts, removedBytes }
  })
}
