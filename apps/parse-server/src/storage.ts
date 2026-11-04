import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat as fsStat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { DocFormat } from '@genoffice/parse-contract'

export class UploadTooLargeError extends Error {
  readonly code = 'upload_too_large'
  constructor(readonly limit: number) {
    super(`upload exceeds the ${limit}-byte limit`)
    this.name = 'UploadTooLargeError'
  }
}

export interface StoredFile {
  fileId: string
  sha256: string
  size: number
  format: DocFormat
  createdAt: string
}

interface TempUpload {
  tempPath: string
  sha256: string
  size: number
}

/**
 * Content-addressed file store.
 *
 * Bytes are streamed into a temp file while hashing; only after the format is
 * known does `commit` move them under `files/<sha256>`. Nothing here ever
 * holds a whole document in memory, which is the point of the service.
 */
export class ContentStore {
  constructor(readonly root: string) {}

  private get filesDir(): string {
    return join(this.root, 'files')
  }

  private get metaDir(): string {
    return join(this.root, 'meta')
  }

  private get tmpDir(): string {
    return join(this.root, 'tmp')
  }

  async init(): Promise<void> {
    await mkdir(this.filesDir, { recursive: true })
    await mkdir(this.metaDir, { recursive: true })
    await mkdir(this.tmpDir, { recursive: true })
  }

  /** Stream `input` into a temp file, hashing as it goes. */
  async writeTemp(input: Readable, maxBytes: number): Promise<TempUpload> {
    const tempPath = join(this.tmpDir, `${randomUUID()}.part`)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > maxBytes) {
          callback(new UploadTooLargeError(maxBytes))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    try {
      await pipeline(input, meter, createWriteStream(tempPath))
    } catch (error) {
      await rm(tempPath, { force: true })
      throw error
    }
    return { tempPath, sha256: hash.digest('hex'), size }
  }

  /** Move a finished temp upload into the content-addressed store. */
  async commit(upload: TempUpload, format: DocFormat): Promise<StoredFile> {
    const finalPath = this.contentPath(upload.sha256)
    await mkdir(dirname(finalPath), { recursive: true })
    try {
      await rename(upload.tempPath, finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await rm(upload.tempPath, { force: true })
    }
    const meta: StoredFile = {
      fileId: upload.sha256,
      sha256: upload.sha256,
      size: upload.size,
      format,
      createdAt: new Date().toISOString(),
    }
    await writeFile(this.metaPath(upload.sha256), JSON.stringify(meta))
    return meta
  }

  async abort(upload: TempUpload): Promise<void> {
    await rm(upload.tempPath, { force: true })
  }

  async stat(fileId: string): Promise<StoredFile | null> {
    try {
      const raw = await readFile(this.metaPath(fileId), 'utf8')
      const meta = JSON.parse(raw) as StoredFile
      if (meta.fileId !== fileId || typeof meta.size !== 'number') return null
      return meta
    } catch {
      return null
    }
  }

  /** Absolute path for a stored file, or null when it does not exist. */
  async pathOf(fileId: string): Promise<string | null> {
    const meta = await this.stat(fileId)
    if (!meta) return null
    const path = this.contentPath(fileId)
    try {
      const handle = await open(path, 'r')
      await handle.close()
      return path
    } catch {
      return null
    }
  }

  /** Inclusive byte range stream. The caller validates `start`/`end` against `stat`. */
  async readRange(fileId: string, start: number, end: number): Promise<ReadStream | null> {
    const path = await this.pathOf(fileId)
    if (!path) return null
    return createReadStream(path, { start, end })
  }

  async remove(fileId: string): Promise<void> {
    await unlink(this.contentPath(fileId)).catch(() => undefined)
    await unlink(this.metaPath(fileId)).catch(() => undefined)
  }

  /** All committed files, newest metadata read from disk. */
  async list(): Promise<StoredFile[]> {
    let names: string[]
    try {
      names = await readdir(this.metaDir)
    } catch {
      return []
    }
    const files: StoredFile[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const meta = JSON.parse(await readFile(join(this.metaDir, name), 'utf8')) as StoredFile
        if (meta.fileId === name.slice(0, -5) && typeof meta.size === 'number') files.push(meta)
      } catch {
        /* skip a corrupt meta file */
      }
    }
    return files
  }

  async totalBytes(): Promise<number> {
    return (await this.list()).reduce((total, file) => total + file.size, 0)
  }

  /** Remove stale upload temp files left by aborted or crashed requests. */
  async cleanupTemp(maxAgeMs: number): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.tmpDir)
    } catch {
      return
    }
    const cutoff = Date.now() - maxAgeMs
    for (const name of names) {
      const path = join(this.tmpDir, name)
      try {
        const info = await fsStat(path)
        if (info.mtimeMs < cutoff) await unlink(path)
      } catch {
        /* raced with another request */
      }
    }
  }

  private contentPath(sha256: string): string {
    return join(this.filesDir, sha256.slice(0, 2), sha256)
  }

  private metaPath(sha256: string): string {
    return join(this.metaDir, `${sha256}.json`)
  }
}
