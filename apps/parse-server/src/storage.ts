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
import type { MysqlDatabase } from './mysql'

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
  private readonly activeTemp = new Set<string>()
  constructor(
    readonly root: string,
    private readonly db?: MysqlDatabase,
  ) {}

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
    await this.db?.init()
    await mkdir(this.filesDir, { recursive: true })
    await mkdir(this.metaDir, { recursive: true })
    await mkdir(this.tmpDir, { recursive: true })
  }

  /** Stream `input` into a temp file, hashing as it goes. */
  async writeTemp(
    input: Readable,
    maxBytes: number,
    reserve?: (bytes: number) => Promise<void>,
  ): Promise<TempUpload> {
    const tempPath = join(this.tmpDir, `${randomUUID()}.part`)
    this.activeTemp.add(tempPath)
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length
        if (size > maxBytes) {
          callback(new UploadTooLargeError(maxBytes))
          return
        }
        const accept = () => {
          hash.update(chunk)
          callback(null, chunk)
        }
        if (reserve) void reserve(chunk.length).then(accept, (error: Error) => callback(error))
        else accept()
      },
    })
    const fail = (error: Error) => {
      meter.destroy(error)
    }
    const closed = () => {
      if (!input.readableEnded) fail(new Error('upload stream closed before completion'))
    }
    input.once('error', fail)
    input.once('close', closed)
    try {
      // Keep the HTTP request outside pipeline: rejecting a write must still allow
      // the caller to send 413/507 instead of destroying the response socket.
      input.pipe(meter)
      await pipeline(meter, createWriteStream(tempPath))
    } catch (error) {
      input.unpipe(meter)
      input.resume()
      try {
        await rm(tempPath, { force: true })
      } finally {
        this.activeTemp.delete(tempPath)
      }
      throw error
    } finally {
      input.removeListener('error', fail)
      input.removeListener('close', closed)
    }
    return { tempPath, sha256: hash.digest('hex'), size }
  }

  /** Move a finished temp upload into the content-addressed store. */
  async commit(upload: TempUpload, format: DocFormat): Promise<StoredFile> {
    const existing = await this.stat(upload.sha256)
    if (
      existing &&
      existing.size === upload.size &&
      existing.format === format &&
      (await this.pathOf(upload.sha256))
    ) {
      await this.abort(upload)
      return existing
    }
    const finalPath = this.contentPath(upload.sha256)
    await mkdir(dirname(finalPath), { recursive: true })
    try {
      await rename(upload.tempPath, finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await rm(upload.tempPath, { force: true })
    }
    this.activeTemp.delete(upload.tempPath)
    const meta: StoredFile = {
      fileId: upload.sha256,
      sha256: upload.sha256,
      size: upload.size,
      format,
      createdAt: new Date().toISOString(),
    }
    await writeFile(this.metaPath(upload.sha256), JSON.stringify(meta))
    await this.db?.pool.query(
      `INSERT INTO parse_files
         (file_id, sha256, size, format, created_at, storage_state, verified_at)
       VALUES (?, ?, ?, ?, ?, 'stored', ?)
       ON DUPLICATE KEY UPDATE sha256=VALUES(sha256), size=VALUES(size), format=VALUES(format),
         storage_state=VALUES(storage_state),
         verified_at=GREATEST(COALESCE(verified_at, 0), VALUES(verified_at))`,
      [meta.fileId, meta.sha256, meta.size, meta.format, meta.createdAt, Date.now()],
    )
    return meta
  }

  async abort(upload: TempUpload): Promise<void> {
    await rm(upload.tempPath, { force: true })
    this.activeTemp.delete(upload.tempPath)
  }

  async stat(fileId: string): Promise<StoredFile | null> {
    if (this.db) {
      const [rows] = await this.db.pool.query(
        'SELECT file_id, sha256, size, format, created_at FROM parse_files WHERE file_id = ? LIMIT 1',
        [fileId],
      )
      const row = (rows as any[])[0]
      if (!row) return null
      return {
        fileId: String(row.file_id),
        sha256: String(row.sha256),
        size: Number(row.size),
        format: String(row.format) as DocFormat,
        createdAt: String(row.created_at),
      }
    }
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
    await this.db?.pool.query('DELETE FROM parse_files WHERE file_id = ?', [fileId])
    await unlink(this.contentPath(fileId)).catch(() => undefined)
    await unlink(this.metaPath(fileId)).catch(() => undefined)
  }

  /** All committed files, newest metadata read from disk. */
  async list(): Promise<StoredFile[]> {
    if (this.db) {
      const [rows] = await this.db.pool.query(
        'SELECT file_id, sha256, size, format, created_at FROM parse_files ORDER BY created_at DESC',
      )
      return (rows as any[]).map((row) => ({
        fileId: String(row.file_id),
        sha256: String(row.sha256),
        size: Number(row.size),
        format: String(row.format) as DocFormat,
        createdAt: String(row.created_at),
      }))
    }
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

  /** Stable metadata paging; document bytes are never read for a list request. */
  async page(
    limit: number,
    after?: { createdAt: string; fileId: string },
  ): Promise<{ items: StoredFile[]; hasMore: boolean }> {
    if (this.db) {
      const where = after ? 'WHERE created_at < ? OR (created_at = ? AND file_id > ?)' : ''
      const [rows] = await this.db.pool.query(
        `SELECT file_id, sha256, size, format, created_at FROM parse_files ${where} ORDER BY created_at DESC, file_id ASC LIMIT ?`,
        [...(after ? [after.createdAt, after.createdAt, after.fileId] : []), limit + 1],
      )
      const items = (rows as any[]).map((row) => ({
        fileId: String(row.file_id),
        sha256: String(row.sha256),
        size: Number(row.size),
        format: String(row.format) as DocFormat,
        createdAt: String(row.created_at),
      }))
      return { items: items.slice(0, limit), hasMore: items.length > limit }
    }
    let items = (await this.list()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.fileId.localeCompare(b.fileId),
    )
    if (after)
      items = items.filter(
        (file) =>
          file.createdAt < after.createdAt ||
          (file.createdAt === after.createdAt && file.fileId > after.fileId),
      )
    return { items: items.slice(0, limit), hasMore: items.length > limit }
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
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.part$/.test(name))
        continue
      const path = join(this.tmpDir, name)
      if (this.activeTemp.has(path)) continue
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
