import type { StorageBudget, StorageReservation } from './storage-budget'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 100_000
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Canonical, explicit JSON: reject runtime objects rather than silently losing fields. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`
  }
  throw new Error('artifact DTO must contain only finite JSON values')
}

export interface ArtifactIdentity {
  fileId: string
  format: 'pptx' | 'docx' | 'pdf'
  parserFingerprint: string
  schemaVersion: number
  options: JsonValue
}

export function artifactKey(identity: ArtifactIdentity): string {
  if (
    !HASH.test(identity.fileId) ||
    !identity.parserFingerprint ||
    !Number.isSafeInteger(identity.schemaVersion) ||
    identity.schemaVersion < 1
  ) {
    throw new Error('invalid artifact identity')
  }
  return createHash('sha256').update(canonicalJson(identity)).digest('hex')
}

interface RecordEntry {
  id: string
  encoding: 'json' | 'bytes'
  offset: number
  length: number
  rawLength: number
  sha256: string
}

export interface ArtifactManifest {
  version: 1
  key: string
  identity: ArtifactIdentity
  createdAt: number
  dataBytes: number
  records: RecordEntry[]
}

function validateManifest(value: ArtifactManifest, key: string, maxBytes: number): void {
  if (
    value?.version !== 1 ||
    value.key !== key ||
    artifactKey(value.identity) !== key ||
    !Number.isSafeInteger(value.dataBytes) ||
    value.dataBytes < 0 ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_ENTRIES
  ) {
    throw new ArtifactCorruptionError('invalid artifact manifest')
  }
  const ids = new Set<string>()
  let offset = 0
  for (const entry of value.records) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      !entry.id ||
      ids.has(entry.id) ||
      !['json', 'bytes'].includes(entry.encoding) ||
      !HASH.test(entry.sha256) ||
      !Number.isSafeInteger(entry.offset) ||
      entry.offset !== offset ||
      !Number.isSafeInteger(entry.length) ||
      entry.length <= 0 ||
      entry.length > maxBytes + 65536 ||
      !Number.isSafeInteger(entry.rawLength) ||
      entry.rawLength < 0 ||
      entry.rawLength > maxBytes
    ) {
      throw new ArtifactCorruptionError('invalid artifact record index')
    }
    ids.add(entry.id)
    offset += entry.length
  }
  if (offset !== value.dataBytes) throw new ArtifactCorruptionError('artifact data length mismatch')
}

export class ArtifactCorruptionError extends Error {
  /** Stable across IPC: the parser process cannot serialize Error subclasses. */
  readonly code = 'artifact_corrupt'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ArtifactCorruptionError'
  }
}

export class ArtifactReader {
  static async openDirectory(
    directory: string, key: string, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES, manifestSha256?: string,
    onCorruption?: (error: ArtifactCorruptionError) => void,
  ): Promise<ArtifactReader> {
    const path = join(directory, 'manifest.json')
    try {
      if ((await stat(path)).size > MAX_MANIFEST_BYTES)
        throw new ArtifactCorruptionError('artifact manifest exceeds byte budget')
      const bytes = await readFile(path)
      if (manifestSha256 && createHash('sha256').update(bytes).digest('hex') !== manifestSha256)
        throw new ArtifactCorruptionError('artifact manifest checksum mismatch')
      let manifest: ArtifactManifest
      try {
        manifest = JSON.parse(bytes.toString('utf8')) as ArtifactManifest
        validateManifest(manifest, key, maxRecordBytes)
      } catch (cause) { throw new ArtifactCorruptionError('invalid artifact manifest', { cause }) }
      if ((await stat(join(directory, 'units.bin'))).size !== manifest.dataBytes)
        throw new ArtifactCorruptionError('artifact data length mismatch')
      return new ArtifactReader(directory, manifest, maxRecordBytes, onCorruption)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ArtifactCorruptionError('artifact generation missing', { cause: error })
      throw error
    }
  }
  private digest?: string
  get contentDigest(): string {
    if (!this.digest) {
      const hash = createHash('sha256')
      for (const entry of this.manifest.records)
        hash.update(JSON.stringify([entry.id, entry.rawLength, entry.sha256]) + '\n')
      this.digest = hash.digest('hex')
    }
    return this.digest
  }

  private corruption?: ArtifactCorruptionError

  invalidate(error: ArtifactCorruptionError): void {
    this.corruption = error
  }

  assertHealthy(): void {
    if (this.corruption) throw this.corruption
  }
  private readonly entries: Map<string, RecordEntry>
  constructor(
    readonly directory: string,
    readonly manifest: ArtifactManifest,
    private readonly maxRecordBytes: number,
    private readonly onCorruption?: (error: ArtifactCorruptionError) => void,
    private readonly onRead?: () => Promise<void>,
  ) {
    this.entries = new Map(manifest.records.map((entry) => [entry.id, entry]))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  describe(id: string): { size: number; sha256: string } {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('unknown artifact record')
    return { size: entry.rawLength, sha256: entry.sha256 }
  }

  async read(id: string): Promise<JsonValue | Buffer> {
    this.assertHealthy()
    await this.onRead?.()
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`artifact record not found: ${id}`)
    const file = await open(join(this.directory, 'units.bin'), 'r')
    try {
      const bytes = Buffer.alloc(entry.length)
      let done = 0
      while (done < bytes.length) {
        const { bytesRead } = await file.read(bytes, done, bytes.length - done, entry.offset + done)
        if (!bytesRead) throw new ArtifactCorruptionError('artifact record truncated')
        done += bytesRead
      }
      let raw: Buffer
      try {
        raw = await decompress(bytes, { maxOutputLength: this.maxRecordBytes })
      } catch (cause) {
        throw new ArtifactCorruptionError('artifact record compression invalid', { cause })
      }
      if (
        raw.length !== entry.rawLength ||
        createHash('sha256').update(raw).digest('hex') !== entry.sha256
      ) {
        throw new ArtifactCorruptionError('artifact record checksum mismatch')
      }
      return entry.encoding === 'bytes' ? raw : (JSON.parse(raw.toString('utf8')) as JsonValue)
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) {
        // Report once per reader: concurrent reads of the same damaged frame must
        // not stampede the catalog's compare-and-clear invalidation.
        const first = !this.corruption
        this.corruption = error
        if (first) this.onCorruption?.(error)
      }
      throw error
    } finally {
      await file.close()
    }
  }
}

/** Incremental single-writer output. No partially written record is published. */
export class ArtifactWriter {
  private records: RecordEntry[] = []
  private ids = new Map<string, RecordEntry>()
  private offset = 0
  private finished = false
  private busy = false

  constructor(
    private readonly file: FileHandle,
    private readonly staging: string,
    private readonly destination: string,
    private readonly identity: ArtifactIdentity,
    private readonly maxRecordBytes: number,
    private readonly reservation?: StorageReservation,
    private readonly durableDirectories = false,
  ) {}

  async append(id: string, value: JsonValue | Uint8Array): Promise<void> {
    if (this.finished || this.busy) throw new Error('artifact writer is closed or busy')
    if (!id || this.ids.has(id) || this.records.length >= MAX_ENTRIES)
      throw new Error('invalid or duplicate artifact record')
    this.busy = true
    try {
      const binary = value instanceof Uint8Array
      const raw = binary ? Buffer.from(value) : Buffer.from(canonicalJson(value))
      if (raw.length > this.maxRecordBytes) throw new Error('artifact record exceeds byte budget')
      const bytes = await compress(raw)
      await this.reservation?.reserve(bytes.length)
      let done = 0
      while (done < bytes.length) {
        const { bytesWritten } = await this.file.write(
          bytes,
          done,
          bytes.length - done,
          this.offset + done,
        )
        if (!bytesWritten) throw new Error('artifact write made no progress')
        done += bytesWritten
      }
      const entry: RecordEntry = {
        id,
        encoding: binary ? 'bytes' : 'json',
        offset: this.offset,
        length: bytes.length,
        rawLength: raw.length,
        sha256: createHash('sha256').update(raw).digest('hex'),
      }
      this.records.push(entry)
      this.ids.set(id, entry)
      this.offset += bytes.length
    } finally {
      this.busy = false
    }
  }

  describe(id: string): { size: number; sha256: string } {
    const entry = this.ids.get(id)
    if (!entry) throw new Error('unknown artifact record')
    return { size: entry.rawLength, sha256: entry.sha256 }
  }

  async publish(): Promise<void> {
    if (this.finished || this.busy) throw new Error('artifact writer is closed or busy')
    this.finished = true
    try {
      await this.file.sync()
      await this.file.close()
      const manifest: ArtifactManifest = {
        version: 1,
        key: artifactKey(this.identity),
        identity: this.identity,
        createdAt: Date.now(),
        dataBytes: this.offset,
        records: this.records,
      }
      const bytes = Buffer.from(canonicalJson(manifest))
      if (bytes.length > MAX_MANIFEST_BYTES)
        throw new ArtifactCorruptionError('artifact manifest exceeds byte budget')
      await this.reservation?.reserve(bytes.length)
      const index = await open(join(this.staging, 'manifest.json'), 'wx')
      try {
        await index.writeFile(bytes)
        await index.sync()
      } finally {
        await index.close()
      }
      await mkdir(join(this.destination, '..'), { recursive: true })
      if (this.durableDirectories) await syncArtifactDirectory(this.staging)
      await rename(this.staging, this.destination)
    } catch (error) {
      await this.file.close().catch(() => undefined)
      await rm(this.staging, { recursive: true, force: true })
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.busy) throw new Error('cannot abort an active artifact write')
    if (this.finished) return
    this.finished = true
    await this.file.close()
    await rm(this.staging, { recursive: true, force: true })
  }
}

/** Fail closed if the filesystem cannot confirm directory durability. */
export async function syncArtifactDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Local-disk backend. Cross-process job leases belong to the catalog, not this store. */
export class ArtifactStore {
  private readonly building = new Map<string, Promise<ArtifactReader>>()
  private readonly ownedTasks = new Map<Promise<unknown>, string>()
  private readonly buildingFiles = new Map<string, string>()
  private readonly admitted = new Set<string>()
  private readonly admissionListeners = new Map<string, Set<() => void>>()
  markAdmitted(key: string): void {
    this.admitted.add(key)
    for (const listener of this.admissionListeners.get(key) ?? []) listener()
    this.admissionListeners.delete(key)
  }
  private observeAdmission(key: string, listener?: () => void): void {
    if (!listener) return
    if (this.admitted.has(key)) {
      listener()
      return
    }
    const listeners = this.admissionListeners.get(key) ?? new Set()
    listeners.add(listener)
    this.admissionListeners.set(key, listeners)
  }
  private readonly phases = new Map<string, 'queued' | 'building'>()
  phase(key: string): 'queued' | 'building' {
    return this.phases.get(key) ?? 'queued'
  }
  markRunning(key: string): void {
    this.phases.set(key, 'building')
  }
  finishProgress(key: string): void {
    this.phases.delete(key)
    this.admitted.delete(key)
    this.admissionListeners.delete(key)
  }
  private readonly readers = new Map<
    string,
    { reader: WeakRef<ArtifactReader>; mtime: number; bytes: number }
  >()
  private readonly corruptions = new Map<string, ArtifactCorruptionError>()
  private readonly staging = new Set<string>()
  private readonly access = new Map<string, number>()
  readonly stats = {
    hits: 0,
    buildsStarted: 0,
    sourceParsesStarted: 0,
    sharedWaiters: 0,
    legacyImports: 0,
    legacyBundleImports: 0,
    evicted: 0,
    evictedBytes: 0,
  }
  get activeBuilds(): number {
    return this.building.size
  }
  constructor(
    readonly root: string,
    private readonly maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
    private readonly storageBudget?: StorageBudget,
  ) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0)
      throw new Error('invalid artifact byte budget')
  }

  scratchReservation(): StorageReservation | undefined {
    return this.storageBudget?.reservation()
  }

  private directory(key: string): string {
    if (!HASH.test(key)) throw new Error('invalid artifact key')
    return join(this.root, 'artifacts', key.slice(0, 2), key)
  }

  async find(key: string): Promise<ArtifactReader | null> {
    try {
      return await this.findUnchecked(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ArtifactCorruptionError('artifact data missing', { cause: error })
      throw error
    }
  }

  private async findUnchecked(key: string): Promise<ArtifactReader | null> {
    const directory = this.directory(key)
    const corruption = this.corruptions.get(key)
    if (corruption) throw corruption
    let bytes: Buffer
    try {
      const path = join(directory, 'manifest.json')
      const info = await stat(path)
      const cached = this.readers.get(key)
      const shared = cached?.reader.deref()
      if (shared && cached?.mtime === info.mtimeMs && cached.bytes === info.size) {
        shared.assertHealthy()
        if ((await stat(join(directory, 'units.bin'))).size !== shared.manifest.dataBytes)
          throw new ArtifactCorruptionError('artifact data length mismatch')
        return shared
      }
      if (info.size > MAX_MANIFEST_BYTES)
        throw new ArtifactCorruptionError('artifact manifest exceeds byte budget')
      bytes = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await stat(directory)
        } catch (directoryError) {
          if ((directoryError as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw directoryError
        }
        throw new ArtifactCorruptionError('artifact manifest or data missing', { cause: error })
      }
      throw error
    }
    let manifest: ArtifactManifest
    try {
      manifest = JSON.parse(bytes.toString('utf8')) as ArtifactManifest
      validateManifest(manifest, key, this.maxRecordBytes)
    } catch (cause) {
      throw new ArtifactCorruptionError('invalid artifact manifest', { cause })
    }
    if ((await stat(join(directory, 'units.bin'))).size !== manifest.dataBytes)
      throw new ArtifactCorruptionError('artifact data length mismatch')
    const reader = new ArtifactReader(
      directory,
      manifest,
      this.maxRecordBytes,
      (error) => {
        // Keep the fault independent of WeakRef lifetime, but fence late old readers.
        if (this.readers.get(key)?.reader.deref() === reader) this.corruptions.set(key, error)
      },
      async () => {
        const now = Date.now()
        if (now - (this.access.get(key) ?? 0) < 30_000) return
        if (this.access.size >= 10_000) this.access.delete(this.access.keys().next().value!)
        this.access.set(key, now)
        // Best-effort coalesced access hint; cache reads still work on read-only mounts.
        await utimes(directory, new Date(now), new Date(now)).catch(() => undefined)
      },
    )
    const info = await stat(join(directory, 'manifest.json'))
    if (this.readers.size >= 512) this.readers.delete(this.readers.keys().next().value!)
    this.readers.set(key, { reader: new WeakRef(reader), mtime: info.mtimeMs, bytes: info.size })
    return reader
  }

  get activeFileIds(): Set<string> {
    return new Set([...this.buildingFiles.values(), ...this.ownedTasks.values()])
  }

  /** Register ownership before asynchronous dependency acquisition or build admission begins. */
  runOwned<T>(fileId: string, work: () => Promise<T>): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(fileId)) throw new Error('invalid artifact source file')
    let resolve!: (value: T | PromiseLike<T>) => void
    let reject!: (reason: unknown) => void
    const task = new Promise<T>((done, fail) => { resolve = done; reject = fail })
    this.ownedTasks.set(task, fileId)
    void task.finally(() => this.ownedTasks.delete(task)).catch(() => undefined)
    // Start dependency acquisition synchronously, after registering ownership.
    try { resolve(work()) } catch (error) { reject(error) }
    return task
  }

  async drain(): Promise<void> {
    while (this.building.size || this.ownedTasks.size)
      await Promise.allSettled([...this.building.values(), ...this.ownedTasks.keys()])
  }

  async list(): Promise<ArtifactReader[]> {
    const root = join(this.root, 'artifacts')
    let prefixes
    try {
      prefixes = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const readers: ArtifactReader[] = []
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue
      for (const entry of await readdir(join(root, prefix.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || !HASH.test(entry.name) || !entry.name.startsWith(prefix.name)) continue
        const children = await readdir(this.directory(entry.name), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
        if (children.some((child) => child.isDirectory())) continue
        const reader = await this.find(entry.name)
        if (reader) readers.push(reader)
      }
    }
    return readers
  }

  async removeForFile(fileId: string): Promise<void> {
    if (this.activeFileIds.has(fileId)) throw new Error('artifact is currently building')
    for (const reader of await this.list()) {
      if (reader.manifest.identity.fileId === fileId) {
        this.readers.delete(reader.manifest.key)
        await this.removeLegacyFiles(reader.manifest.key)
        this.access.delete(reader.manifest.key)
        this.corruptions.delete(reader.manifest.key)
      }
    }
  }

  private async diskEntries(): Promise<
    Array<{ key: string; directory: string; bytes: number; accessedAt: number; nested: boolean }>
  > {
    const root = join(this.root, 'artifacts')
    const result: Array<{ key: string; directory: string; bytes: number; accessedAt: number; nested: boolean }> = []
    let prefixes
    try {
      prefixes = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
      throw error
    }
    for (const prefix of prefixes) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue
      for (const entry of await readdir(join(root, prefix.name), { withFileTypes: true })) {
        if (!entry.isDirectory() || !HASH.test(entry.name) || !entry.name.startsWith(prefix.name))
          continue
        const directory = this.directory(entry.name)
        try {
          const info = await stat(directory)
          let bytes = 0
          let nested = false
          const pending = [directory]
          while (pending.length) {
            const current = pending.pop()!
            let files
            try { files = await readdir(current, { withFileTypes: true }) }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
              throw error
            }
            for (const file of files) {
              const path = join(current, file.name)
              if (file.isDirectory()) { nested = true; pending.push(path) }
              else if (file.isFile()) {
                try {
                  const fileInfo = await lstat(path)
                  if (fileInfo.isFile()) bytes += fileInfo.size
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
                }
              }
            }
          }
          result.push({
            key: entry.name,
            directory,
            bytes,
            accessedAt: this.access.get(entry.name) ?? info.mtimeMs,
            nested,
          })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
    return result
  }

  async cleanupStaging(maxAgeMs: number): Promise<number> {
    const root = join(this.root, 'staging')
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let removed = 0
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name)
      )
        continue
      const path = join(root, entry.name)
      if (this.staging.has(path)) continue
      try {
        if ((await stat(path)).mtimeMs >= Date.now() - maxAgeMs) continue
        await rm(path, { recursive: true, force: true })
        removed++
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return removed
  }

  async totalBytes(): Promise<number> {
    // Quota accounting must not depend on a healthy model index.
    return (await this.diskEntries()).reduce((sum, entry) => sum + entry.bytes, 0)
  }

  async evictionCandidates(
    currentFingerprint: string,
  ): Promise<
    Array<{ key: string; fileId: string; bytes: number; accessedAt: number; oldVersion: boolean }>
  > {
    const candidates = []
    for (const entry of await this.diskEntries()) {
      // Only the catalog can decide which generations are no longer read or ready.
      if (entry.nested) continue
      try {
        const reader = await this.find(entry.key)
        if (reader)
          candidates.push({
            ...entry,
            fileId: reader.manifest.identity.fileId,
            oldVersion: reader.manifest.identity.parserFingerprint !== currentFingerprint,
          })
      } catch (error) {
        // Corrupt indexes cannot establish ownership; retain their bytes and report
        // them in quota, rather than guessing which source may be reconstructed.
        if (!(error instanceof ArtifactCorruptionError)) throw error
      }
    }
    return candidates.sort(
      (a, b) => Number(b.oldVersion) - Number(a.oldVersion) || a.accessedAt - b.accessedAt,
    )
  }

  async evict(key: string): Promise<number> {
    if (this.building.has(key)) return 0
    const entry = (await this.diskEntries()).find((entry) => entry.key === key)
    if (!entry || entry.nested) return 0
    const reader = await this.find(key)
    if (!reader || this.activeFileIds.has(reader.manifest.identity.fileId)) return 0
    const bytes = await this.removeLegacyFiles(key)
    this.readers.delete(key)
    this.access.delete(key)
    this.corruptions.delete(key)
    this.stats.evicted++
    this.stats.evictedBytes += bytes
    return bytes
  }

  private async removeLegacyFiles(key: string): Promise<number> {
    const directory = this.directory(key)
    let bytes = 0
    for (const name of ['manifest.json', 'units.bin']) {
      const path = join(directory, name)
      try {
        const info = await lstat(path)
        await unlink(path)
        if (info.isFile()) bytes += info.size
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    // Atomic empty-directory removal cannot erase a generation created during eviction.
    await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')) throw error
    })
    return bytes
  }

  async getOrBuild(
    identity: ArtifactIdentity,
    build: (writer: ArtifactWriter) => Promise<void>,
    onAdmission?: () => void,
    validateCached?: (reader: ArtifactReader) => Promise<void>,
  ): Promise<ArtifactReader> {
    const key = artifactKey(identity)
    this.observeAdmission(key, onAdmission)
    const pending = this.building.get(key)
    if (pending) {
      this.stats.sharedWaiters++
      return pending
    }
    const task = (async () => {
      let cached: ArtifactReader | null
      try {
        cached = await this.find(key)
        if (cached && validateCached) await validateCached(cached)
      } catch (error) {
        if (!(error instanceof ArtifactCorruptionError)) throw error
        // Only the single-flight owner removes a proven corrupt derived artifact.
        // Filesystem permission/I/O errors propagate without deleting anything.
        this.readers.get(key)?.reader.deref()?.invalidate(error)
        this.readers.delete(key)
        const children = await readdir(this.directory(key), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        })
        if (children.some((entry) => entry.isDirectory()))
          throw new Error('generation artifact requires the catalog backend', { cause: error })
        await this.removeLegacyFiles(key)
        this.corruptions.delete(key)
        cached = null
      }
      if (cached) {
        this.stats.hits++
        this.markAdmitted(key)
        return cached
      }
      this.stats.buildsStarted++
      const staging = join(this.root, 'staging', randomUUID())
      this.staging.add(staging)
      try {
        await mkdir(staging, { recursive: true })
        const file = await open(join(staging, 'units.bin'), 'wx')
        const reservation = this.storageBudget?.reservation()
        const writer = new ArtifactWriter(
          file,
          staging,
          this.directory(key),
          identity,
          this.maxRecordBytes,
          reservation,
        )
        try {
          await build(writer)
          await writer.publish()
        } catch (error) {
          await writer.abort()
          throw error
        } finally {
          await reservation?.release()
        }
        const reader = await this.find(key)
        if (!reader) throw new Error('published artifact is missing')
        return reader
      } finally {
        this.staging.delete(staging)
      }
    })()
    this.building.set(key, task)
    this.phases.set(key, 'queued')
    this.buildingFiles.set(key, identity.fileId)
    try {
      return await task
    } finally {
      if (this.building.get(key) === task) {
        this.building.delete(key)
        this.phases.delete(key)
        this.admitted.delete(key)
        this.admissionListeners.delete(key)
        this.buildingFiles.delete(key)
      }
    }
  }
}
