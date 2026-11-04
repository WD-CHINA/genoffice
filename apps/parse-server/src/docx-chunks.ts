import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ChunkManifest {
  version: 1
  fileId: string
  parserVersion: string
  unitCount: number
  chunkBlocks: number
  createdAt: number
}

export function chunkDir(root: string, sessionId: string): string {
  return join(root, sessionId)
}

export async function readChunkManifest(dir: string): Promise<ChunkManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ChunkManifest
    if (
      parsed?.version === 1 &&
      typeof parsed.fileId === 'string' &&
      typeof parsed.parserVersion === 'string' &&
      Number.isInteger(parsed.unitCount) &&
      Number.isInteger(parsed.chunkBlocks)
    ) {
      return parsed
    }
  } catch {
    /* missing or corrupt manifest */
  }
  return null
}

export async function writeChunkManifest(dir: string, manifest: ChunkManifest): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, 'manifest.json.tmp')
  await writeFile(tmp, JSON.stringify(manifest))
  await rename(tmp, join(dir, 'manifest.json'))
}

export async function writeChunk(dir: string, index: number, blocks: unknown[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `chunk-${index}.json.tmp`)
  await writeFile(tmp, JSON.stringify(blocks))
  await rename(tmp, join(dir, `chunk-${index}.json`))
}

export async function readChunk(dir: string, index: number): Promise<unknown[]> {
  return JSON.parse(await readFile(join(dir, `chunk-${index}.json`), 'utf8')) as unknown[]
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
    if (keep.has(name)) continue
    const path = join(root, name)
    try {
      const info = await stat(path)
      if (info.isDirectory() && info.mtimeMs < cutoff)
        await rm(path, { recursive: true, force: true })
    } catch {
      /* raced with another request */
    }
  }
}
