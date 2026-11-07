import { createHash } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

export interface ChunkEntry {
  offset: number
  length: number
  /** SHA-256 of the uncompressed chunk JSON. */
  hash: string
}

export interface ChunkManifest {
  version: 2
  fileId: string
  parserVersion: string
  unitCount: number
  chunkBlocks: number
  chunkFile: 'chunks.bin'
  chunks: ChunkEntry[]
  createdAt: number
}

export function chunkDir(root: string, sessionId: string): string {
  return join(root, sessionId)
}

export async function readChunkManifest(dir: string): Promise<ChunkManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ChunkManifest
    if (
      parsed?.version === 2 &&
      typeof parsed.fileId === 'string' &&
      typeof parsed.parserVersion === 'string' &&
      Number.isInteger(parsed.unitCount) &&
      Number.isInteger(parsed.chunkBlocks) &&
      parsed.chunkFile === 'chunks.bin' &&
      Array.isArray(parsed.chunks) &&
      parsed.chunks.length === parsed.unitCount
    ) {
      return parsed
    }
  } catch {
    /* missing or corrupt manifest */
  }
  return null
}

export async function writeChunkManifest(
  dir: string,
  manifest: ChunkManifest,
  reserve?: (bytes: number) => Promise<void>,
): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, 'manifest.json.tmp')
  const bytes = Buffer.from(JSON.stringify(manifest))
  await reserve?.(bytes.length)
  await writeFile(tmp, bytes)
  await rename(tmp, join(dir, 'manifest.json'))
}

/**
 * Write all chunks into one `chunks.bin` (gzip frames) plus per-chunk offsets.
 * This avoids thousands of tiny files for large DOCX sessions.
 */
export async function writeChunks(
  dir: string,
  chunks: Iterable<unknown[]> | AsyncIterable<unknown[]>,
  reserve?: (bytes: number) => Promise<void>,
): Promise<ChunkEntry[]> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'chunks.bin')
  const tmp = join(dir, 'chunks.bin.tmp')
  const handle = await open(tmp, 'w')
  const entries: ChunkEntry[] = []
  let offset = 0
  try {
    for await (const blocks of chunks) {
      const raw = Buffer.from(JSON.stringify(blocks))
      const hash = createHash('sha256').update(raw).digest('hex')
      const compressed = gzipSync(raw)
      await reserve?.(compressed.length)
      let written = 0
      while (written < compressed.length) {
        const { bytesWritten } = await handle.write(
          compressed,
          written,
          compressed.length - written,
        )
        if (!bytesWritten) throw new Error('DOCX chunk write made no progress')
        written += bytesWritten
      }
      entries.push({ offset, length: compressed.length, hash })
      offset += compressed.length
    }
  } finally {
    await handle.close()
  }
  await rename(tmp, path)
  return entries
}

export async function readChunk(
  dir: string,
  index: number,
  manifest: ChunkManifest,
): Promise<unknown[]> {
  const entry = manifest.chunks[index]
  if (!entry) throw new Error(`chunk ${index} is missing from the manifest`)
  const handle = await open(join(dir, manifest.chunkFile), 'r')
  try {
    const compressed = Buffer.alloc(entry.length)
    let done = 0
    while (done < entry.length) {
      const { bytesRead } = await handle.read(
        compressed,
        done,
        entry.length - done,
        entry.offset + done,
      )
      if (bytesRead === 0) throw new Error(`chunk ${index} is truncated`)
      done += bytesRead
    }
    const raw = gunzipSync(compressed)
    const hash = createHash('sha256').update(raw).digest('hex')
    if (hash !== entry.hash) throw new Error(`chunk ${index} hash mismatch`)
    return JSON.parse(raw.toString('utf8')) as unknown[]
  } finally {
    await handle.close()
  }
}

export async function removeChunks(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** Remove chunk directories not owned by a live session. */
export async function collectOrphanChunks(
  root: string,
  keep: ReadonlySet<string>,
  maxAgeMs: number,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const name of names) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(name)) continue
    if (keep.has(name)) continue
    const path = join(root, name)
    try {
      const info = await stat(path)
      if (info.isDirectory() && info.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true })
      }
    } catch {
      /* raced with another request */
    }
  }
}
