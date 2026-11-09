/**
 * Consistent backup manifest and post-restore reconciliation.
 *
 * Persistence is not a backup. This module records one coherent view of the
 * three things a restore needs: MySQL directory rows, content-addressed source
 * files and their metadata, and immutable generation directories. Recovery is
 * then a drill: re-read the live catalog, reconcile dependencies, verify every
 * byte against the manifest and prove each ready pointer on disk. A ready
 * pointer that cannot be proven is withdrawn before traffic is accepted.
 *
 * Deliberately excluded: staging/tmp parts, chunk scratch, session state,
 * read leases and storage reservations. Those are transient and are rebuilt or
 * fenced on startup. `parse_artifact_archives` tombstones ARE included because
 * losing one would let a claim reuse a retired generation number.
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  artifactGenerationPath, MysqlArtifactCatalog, type ReadyArtifact,
} from './artifact-catalog'
import { ArtifactCorruptionError, artifactKey, canonicalJson, type ArtifactIdentity } from './artifact-store'
import { ArtifactGenerations } from './artifact-generations'
import type { MysqlDatabase } from './mysql'

export const BACKUP_MANIFEST_VERSION = 1
const HASH = /^[a-f0-9]{64}$/
const BUCKET = /^[a-f0-9]{2}$/
const GENERATION = /^g-([1-9][0-9]*)$/
const SAFE_PATH = /^(?:files\/[a-f0-9]{2}\/[a-f0-9]{64}|meta\/[a-f0-9]{64}\.json|library\.json|artifacts\/[a-f0-9]{2}\/[a-f0-9]{64}\/(?:manifest\.json|units\.bin|g-[1-9][0-9]*\/(?:manifest\.json|units\.bin)))$/

export class BackupManifestError extends Error {
  readonly code = 'backup_manifest_invalid'
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BackupManifestError'
  }
}
export class BackupConcurrencyError extends Error {
  readonly code = 'backup_catalog_changed'
  constructor(message: string) {
    super(message)
    this.name = 'BackupConcurrencyError'
  }
}

export type BackupFileKind = 'source' | 'metadata' | 'artifact'
export interface BackupFileEntry {
  /** POSIX path relative to dataDir; only durable, content-addressed paths. */
  path: string
  kind: BackupFileKind
  size: number
  sha256: string
  /** Source bytes and library/DB indexes are not rebuildable; generations are. */
  required: boolean
}
export interface BackupArtifactRow {
  key: string
  fileId: string
  generation: number
  /** identity JSON must still derive this exact key. */
  identityValid: boolean
  ready: ReadyArtifact | null
  /** A present ready pointer whose fields are illegal and cannot be fenced. */
  readyInvalid: boolean
}
export interface BackupCatalogSnapshot {
  backend: 'mysql' | 'filesystem'
  files: Array<{ fileId: string; sha256: string; size: number; format: string }>
  library: Array<{ id: string; fileId: string }>
  artifacts: BackupArtifactRow[]
  jobs: Array<{ key: string; generation: number }>
  retirements: Array<{ key: string; generation: number }>
  flatArchives: Array<{ key: string; generation: number }>
  archives: Array<{ key: string; fileId: string; generation: number }>
  /** Every durable row that points at a source file (FK-protected relations). */
  references: string[]
}
export interface BackupManifest {
  schemaVersion: 1
  createdAt: number
  catalog: BackupCatalogSnapshot
  entries: BackupFileEntry[]
  digest: string
}

/** The subset whose change would make a file/catalog snapshot incoherent. */
function critical(snapshot: BackupCatalogSnapshot): unknown {
  return {
    backend: snapshot.backend,
    files: snapshot.files,
    library: snapshot.library,
    artifacts: snapshot.artifacts.map((row) => ({
      key: row.key, fileId: row.fileId, generation: row.generation,
      ready: row.ready, readyInvalid: row.readyInvalid,
    })),
    archives: snapshot.archives,
  }
}
function equalCritical(a: BackupCatalogSnapshot, b: BackupCatalogSnapshot): boolean {
  return canonicalJson(critical(a)) === canonicalJson(critical(b))
}
function manifestDigest(body: Omit<BackupManifest, 'digest'>): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex')
}

// ---------------------------------------------------------------------------
// Catalog readers
// ---------------------------------------------------------------------------

type Queryable = Pool | PoolConnection

async function rows(q: Queryable, sql: string): Promise<RowDataPacket[]> {
  const [result] = await q.query<RowDataPacket[]>(sql)
  return result
}
function int(value: unknown): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new BackupManifestError('invalid catalog integer')
  return number
}
function readyOf(row: RowDataPacket): { ready: ReadyArtifact | null; invalid: boolean } {
  if (row.ready_generation === null) return { ready: null, invalid: false }
  try {
    const generation = int(row.ready_generation)
    const storagePath = artifactGenerationPath(row.artifact_key, generation)
    if (row.storage_path !== storagePath || !HASH.test(row.manifest_sha256))
      return { ready: null, invalid: true }
    return { ready: { key: row.artifact_key, generation, storagePath,
      manifestSha256: row.manifest_sha256, bytes: int(row.bytes), unitCount: int(row.unit_count) },
    invalid: false }
  } catch {
    return { ready: null, invalid: true }
  }
}

async function readMysqlCatalog(q: Queryable): Promise<BackupCatalogSnapshot> {
  const fileRows = await rows(q, 'SELECT file_id, sha256, size, format FROM parse_files ORDER BY file_id')
  const libraryRows = await rows(q, 'SELECT id, file_id FROM library_entries ORDER BY id')
  const artifactRows = await rows(q, `SELECT artifact_key, file_id, identity, generation,
    ready_generation, storage_path, manifest_sha256, bytes, unit_count
    FROM parse_artifacts ORDER BY artifact_key`)
  const jobRows = await rows(q, 'SELECT artifact_key, generation FROM parse_jobs ORDER BY artifact_key')
  const retiredRows = await rows(q, `SELECT artifact_key, generation FROM parse_artifact_retirements
    ORDER BY artifact_key, generation`)
  const flatRows = await rows(q, `SELECT artifact_key, generation FROM parse_artifact_flat_archives
    ORDER BY artifact_key`)
  const archiveRows = await rows(q, `SELECT artifact_key, file_id, generation
    FROM parse_artifact_archives ORDER BY artifact_key`)
  const pendingRows = await rows(q, 'SELECT file_id FROM parse_pending_sessions')

  const references = new Set<string>()
  for (const fileId of [
    ...libraryRows.map((row) => String(row.file_id)),
    ...artifactRows.map((row) => String(row.file_id)),
    ...pendingRows.map((row) => String(row.file_id)),
  ]) references.add(fileId)

  return {
    backend: 'mysql',
    files: fileRows.map((row) => ({ fileId: String(row.file_id), sha256: String(row.sha256),
      size: int(row.size), format: String(row.format) })),
    library: libraryRows.map((row) => ({ id: String(row.id), fileId: String(row.file_id) })),
    artifacts: artifactRows.map((row) => {
      const key = String(row.artifact_key)
      let identity: ArtifactIdentity
      try {
        identity = typeof row.identity === 'string'
          ? JSON.parse(row.identity) as ArtifactIdentity : row.identity as ArtifactIdentity
      } catch { return { key, fileId: String(row.file_id), generation: int(row.generation),
        identityValid: false, ready: null, readyInvalid: false } }
      let identityValid = false
      try { identityValid = artifactKey(identity) === key } catch { /* malformed identity */ }
      const pointer = readyOf({ ...row, artifact_key: key, manifest_sha256: String(row.manifest_sha256 ?? '') })
      return { key, fileId: String(row.file_id), generation: int(row.generation),
        identityValid, ready: pointer.ready, readyInvalid: pointer.invalid }
    }),
    jobs: jobRows.map((row) => ({ key: String(row.artifact_key), generation: int(row.generation) })),
    retirements: retiredRows.map((row) => ({ key: String(row.artifact_key), generation: int(row.generation) })),
    flatArchives: flatRows.map((row) => ({ key: String(row.artifact_key), generation: int(row.generation) })),
    archives: archiveRows.map((row) => ({ key: String(row.artifact_key),
      fileId: String(row.file_id), generation: int(row.generation) })),
    references: [...references].sort(),
  }
}

async function readFilesystemCatalog(dataDir: string): Promise<BackupCatalogSnapshot> {
  const files: BackupCatalogSnapshot['files'] = []
  const metaDir = join(dataDir, 'meta')
  let names: string[]
  try { names = await readdir(metaDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    names = []
  }
  for (const name of names.filter((value) => /^[a-f0-9]{64}\.json$/.test(value)).sort()) {
    const fileId = name.slice(0, -5)
    let meta: { fileId?: unknown; sha256?: unknown; size?: unknown; format?: unknown }
    try { meta = JSON.parse(await readFile(join(metaDir, name), 'utf8')) }
    catch (cause) { throw new BackupManifestError('invalid file metadata index', { cause }) }
    if (meta.fileId !== fileId || meta.sha256 !== fileId || typeof meta.size !== 'number'
        || !Number.isSafeInteger(meta.size) || meta.size < 0 || typeof meta.format !== 'string')
      throw new BackupManifestError('invalid file metadata entry')
    files.push({ fileId, sha256: String(meta.sha256), size: meta.size, format: meta.format })
  }
  const library: BackupCatalogSnapshot['library'] = []
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDir, 'library.json'), 'utf8'))
    if (!Array.isArray(parsed)) throw new Error('library is not an array')
    for (const entry of parsed as Array<{ id?: unknown; fileId?: unknown }>)
      if (typeof entry?.id === 'string' && typeof entry.fileId === 'string')
        library.push({ id: entry.id, fileId: entry.fileId })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { backend: 'filesystem', files, library: library.sort((a, b) => a.id < b.id ? -1 : 1),
    artifacts: [], jobs: [], retirements: [], flatArchives: [], archives: [],
    references: [...new Set([...library.map((entry) => entry.fileId)])].sort() }
}

export interface BackupCatalogBoundary {
  snapshot: BackupCatalogSnapshot
  /** Compare with a DIFFERENT connection: the snapshot cannot see later commits. */
  recheck(): Promise<boolean>
  close(): Promise<void>
}
export interface BackupCatalogSource {
  readonly backend: 'mysql' | 'filesystem'
  open(): Promise<BackupCatalogBoundary>
  read(): Promise<BackupCatalogSnapshot>
}

export function mysqlBackupCatalogSource(db: MysqlDatabase): BackupCatalogSource {
  return {
    backend: 'mysql',
    async open() {
      const connection = await db.pool.getConnection()
      let snapshot: BackupCatalogSnapshot
      try {
        await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT')
        snapshot = await readMysqlCatalog(connection)
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined)
        connection.release()
        throw error
      }
      let closed = false
      return {
        snapshot,
        // A REPEATABLE READ snapshot would always agree with itself. The live
        // pool reads outside the transaction, so a concurrent claim/upload that
        // changes files, history, ready pointers or tombstones is detected and
        // the (potentially incoherent) manifest is refused instead of shipped.
        async recheck() { return equalCritical(snapshot, await readMysqlCatalog(db.pool)) },
        async close() {
          if (closed) return
          closed = true
          await connection.query('ROLLBACK').catch(() => undefined)
          connection.release()
        },
      }
    },
    read() { return readMysqlCatalog(db.pool) },
  }
}

export function filesystemBackupCatalogSource(dataDir: string): BackupCatalogSource {
  return {
    backend: 'filesystem',
    async open() {
      const snapshot = await readFilesystemCatalog(dataDir)
      return {
        snapshot,
        async recheck() { return equalCritical(snapshot, await readFilesystemCatalog(dataDir)) },
        async close() { /* nothing to release */ },
      }
    },
    read() { return readFilesystemCatalog(dataDir) },
  }
}

// ---------------------------------------------------------------------------
// Durable file enumeration
// ---------------------------------------------------------------------------

async function entriesOf(directory: string) {
  try { return await readdir(directory, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
function absolute(dataDir: string, path: string): string {
  return join(dataDir, ...path.split('/'))
}
function isRegular(path: string): Promise<boolean> {
  return lstat(path).then((info) => info.isFile(), (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

/** Only canonical, non-symlink durable files are part of a backup. */
export async function listPersistentPaths(dataDir: string): Promise<string[]> {
  const paths: string[] = []
  const add = async (path: string) => {
    if (await isRegular(absolute(dataDir, path))) paths.push(path)
  }
  for (const bucket of await entriesOf(join(dataDir, 'files'))) {
    if (!bucket.isDirectory() || !BUCKET.test(bucket.name)) continue
    for (const file of await entriesOf(join(dataDir, 'files', bucket.name)))
      if (file.isFile() && HASH.test(file.name) && file.name.startsWith(bucket.name))
        await add(`files/${bucket.name}/${file.name}`)
  }
  for (const file of await entriesOf(join(dataDir, 'meta')))
    if (file.isFile() && /^[a-f0-9]{64}\.json$/.test(file.name)) await add(`meta/${file.name}`)
  await add('library.json')
  for (const bucket of await entriesOf(join(dataDir, 'artifacts'))) {
    if (!bucket.isDirectory() || !BUCKET.test(bucket.name)) continue
    const bucketPath = join(dataDir, 'artifacts', bucket.name)
    for (const key of await entriesOf(bucketPath)) {
      if (!key.isDirectory() || !HASH.test(key.name) || !key.name.startsWith(bucket.name)) continue
      const root = `artifacts/${bucket.name}/${key.name}`
      const keyPath = join(bucketPath, key.name)
      for (const name of ['manifest.json', 'units.bin'])
        if (await isRegular(join(keyPath, name))) await add(`${root}/${name}`)
      for (const generation of await entriesOf(keyPath)) {
        const match = GENERATION.exec(generation.name)
        if (!generation.isDirectory() || !match || !Number.isSafeInteger(Number(match[1]))) continue
        for (const name of ['manifest.json', 'units.bin'])
          if (await isRegular(join(keyPath, generation.name, name)))
            await add(`${root}/${generation.name}/${name}`)
      }
    }
  }
  return paths.sort()
}

async function digestFile(dataDir: string, path: string): Promise<{ size: number; sha256: string }> {
  let info
  try { info = await lstat(absolute(dataDir, path)) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT')
      throw new BackupConcurrencyError(`backup path is no longer a file: ${path}`)
    throw cause
  }
  if (!info.isFile()) throw new BackupConcurrencyError(`backup path is no longer a file: ${path}`)
  const hash = createHash('sha256')
  let seen = 0
  for await (const chunk of createReadStream(absolute(dataDir, path))) {
    const buffer = chunk as Buffer
    hash.update(buffer)
    seen += buffer.length
  }
  if (seen !== info.size) throw new BackupConcurrencyError(`backup file changed while hashing: ${path}`)
  return { size: info.size, sha256: hash.digest('hex') }
}
function kindOf(path: string): BackupFileKind {
  if (path.startsWith('files/')) return 'source'
  if (path.startsWith('artifacts/')) return 'artifact'
  return 'metadata'
}

// ---------------------------------------------------------------------------
// Snapshot creation
// ---------------------------------------------------------------------------

export interface CreateBackupOptions {
  dataDir: string
  db?: MysqlDatabase
  /** Injectable for drills/tests; otherwise derived from `db`. */
  source?: BackupCatalogSource
  now?: () => number
}

function assertConsistentCatalog(catalog: BackupCatalogSnapshot): void {
  const fileIds = new Set(catalog.files.map((file) => file.fileId))
  for (const file of catalog.files)
    if (!HASH.test(file.fileId) || file.sha256 !== file.fileId || file.size < 0)
      throw new BackupManifestError('invalid source index row')
  for (const fileId of catalog.references)
    if (!fileIds.has(fileId)) throw new BackupManifestError('dangling source reference in catalog')
  for (const entry of catalog.library)
    if (!fileIds.has(entry.fileId)) throw new BackupManifestError('dangling history reference in catalog')
  for (const row of catalog.artifacts) {
    if (!HASH.test(row.key) || !fileIds.has(row.fileId))
      throw new BackupManifestError('dangling artifact row in catalog')
    if (!row.identityValid) throw new BackupManifestError('artifact identity does not derive its key')
    if (row.readyInvalid) throw new BackupManifestError('catalog contains an invalid ready pointer')
    for (const pointer of row.ready ? [row.ready] : [])
      if (pointer.storagePath !== artifactGenerationPath(row.key, pointer.generation))
        throw new BackupManifestError('invalid generation path in ready pointer')
  }
  for (const row of [...catalog.jobs, ...catalog.retirements, ...catalog.flatArchives])
    if (!HASH.test(row.key)) throw new BackupManifestError('invalid artifact dependency key')
}

export async function createBackupManifest(options: CreateBackupOptions): Promise<BackupManifest> {
  const source = options.source ?? (options.db
    ? mysqlBackupCatalogSource(options.db) : filesystemBackupCatalogSource(options.dataDir))
  const boundary = await source.open()
  try {
    assertConsistentCatalog(boundary.snapshot)
    const entries: BackupFileEntry[] = []
    for (const path of await listPersistentPaths(options.dataDir)) {
      const digest = await digestFile(options.dataDir, path)
      const kind = kindOf(path)
      entries.push({ path, kind, ...digest, required: kind !== 'artifact' })
    }
    if (!await boundary.recheck())
      throw new BackupConcurrencyError('catalog changed while hashing backup files; retry the snapshot')
    const body: Omit<BackupManifest, 'digest'> = {
      schemaVersion: BACKUP_MANIFEST_VERSION,
      createdAt: (options.now ?? Date.now)(),
      catalog: boundary.snapshot,
      entries,
    }
    return { ...body, digest: manifestDigest(body) }
  } finally { await boundary.close() }
}

// ---------------------------------------------------------------------------
// Recovery drill
// ---------------------------------------------------------------------------

export interface RestoreIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
  path?: string
  key?: string
  fileId?: string
}
export interface BlockedReady {
  key: string
  generation: number
  reason: string
  reconciled: boolean
}
export interface RestoreReport {
  ok: boolean
  /** Every remaining ready pointer was proven on disk (withdrawn ones are gone). */
  readyAllowed: boolean
  checkedAt: number
  digest: string
  counts: {
    entries: number
    sourceFiles: number
    metadataFiles: number
    artifactFiles: number
    verifiedBytes: number
    readyPointers: number
  }
  errors: RestoreIssue[]
  warnings: RestoreIssue[]
  readyVerified: string[]
  blockedReady: BlockedReady[]
}
export interface VerifyRestoreOptions {
  dataDir: string
  manifest: BackupManifest
  db?: MysqlDatabase
  source?: BackupCatalogSource
  catalog?: Pick<MysqlArtifactCatalog, 'invalidateReady'>
  generations?: ArtifactGenerations
  /** Also decompress and verify every data frame, not just full-file hashes. */
  deep?: boolean
  /** Withdraw proven-bad ready pointers; false is a read-only drill that must fail closed. */
  invalidate?: boolean
  now?: () => number
}

function assertManifestShape(manifest: BackupManifest): void {
  if (!manifest || manifest.schemaVersion !== BACKUP_MANIFEST_VERSION ||
      !Number.isSafeInteger(manifest.createdAt) || typeof manifest.digest !== 'string' ||
      !HASH.test(manifest.digest) || !Array.isArray(manifest.entries) ||
      !manifest.catalog || !['mysql', 'filesystem'].includes(manifest.catalog.backend) ||
      !Array.isArray(manifest.catalog.files) || !Array.isArray(manifest.catalog.library) ||
      !Array.isArray(manifest.catalog.artifacts) || !Array.isArray(manifest.catalog.archives) ||
      !Array.isArray(manifest.catalog.references))
    throw new BackupManifestError('unsupported or malformed backup manifest')
  for (const entry of manifest.entries)
    if (!entry || !SAFE_PATH.test(entry.path) || typeof entry.kind !== 'string' ||
        !['source', 'metadata', 'artifact'].includes(entry.kind) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 || !HASH.test(entry.sha256) ||
        typeof entry.required !== 'boolean' || entry.required === (entry.kind === 'artifact'))
      throw new BackupManifestError('invalid backup file entry')
  const body = {
    schemaVersion: manifest.schemaVersion,
    createdAt: manifest.createdAt,
    catalog: manifest.catalog,
    entries: manifest.entries,
  }
  if (manifestDigest(body) !== manifest.digest)
    throw new BackupManifestError('backup manifest digest mismatch')
}

/** Recovery drill. Never reports ok/readyAllowed when an unverified ready remains. */
export async function verifyRestore(options: VerifyRestoreOptions): Promise<RestoreReport> {
  const manifest = options.manifest
  assertManifestShape(manifest)
  assertConsistentCatalog(manifest.catalog)
  const source = options.source ?? (options.db
    ? mysqlBackupCatalogSource(options.db) : filesystemBackupCatalogSource(options.dataDir))
  const catalog = options.catalog ?? (options.db ? new MysqlArtifactCatalog(options.db) : undefined)
  const generations = options.generations ?? new ArtifactGenerations(options.dataDir)
  const invalidate = options.invalidate !== false
  const errors: RestoreIssue[] = []
  const warnings: RestoreIssue[] = []
  const error = (code: string, message: string, extra: Partial<RestoreIssue> = {}) =>
    errors.push({ code, severity: 'error', message, ...extra })
  const warn = (code: string, message: string, extra: Partial<RestoreIssue> = {}) =>
    warnings.push({ code, severity: 'warning', message, ...extra })

  const listed = new Map(manifest.entries.map((entry) => [entry.path, entry]))
  const verified = new Set<string>()
  let verifiedBytes = 0
  for (const entry of manifest.entries) {
    let digest: { size: number; sha256: string }
    try { digest = await digestFile(options.dataDir, entry.path) }
    catch (cause) {
      const code = cause instanceof BackupConcurrencyError && /no longer a file/.test(cause.message)
        ? 'missing' : 'unreadable'
      const message = `backup file ${code}: ${entry.path}`
      if (entry.required) error(`${entry.kind}_${code}`, message, { path: entry.path })
      else warn(`artifact_${code}`, message, { path: entry.path })
      continue
    }
    if (digest.size !== entry.size) {
      const message = `backup file size mismatch: ${entry.path}`
      if (entry.required) error(`${entry.kind}_size_mismatch`, message, { path: entry.path })
      else warn('artifact_size_mismatch', message, { path: entry.path })
    } else if (digest.sha256 !== entry.sha256) {
      const message = `backup file checksum mismatch: ${entry.path}`
      if (entry.required) error(`${entry.kind}_checksum_mismatch`, message, { path: entry.path })
      else warn('artifact_checksum_mismatch', message, { path: entry.path })
    } else {
      verified.add(entry.path)
      verifiedBytes += entry.size
    }
  }
  // A catalogued source must actually have bytes in this backup. A manifest
  // taken from an already-inconsistent deployment must not pass the drill just
  // because the files it does contain happen to hash correctly.
  for (const file of manifest.catalog.files) {
    const sourcePath = `files/${file.fileId.slice(0, 2)}/${file.fileId}`
    const metaPath = `meta/${file.fileId}.json`
    for (const path of [sourcePath, metaPath])
      if (!listed.has(path)) error('source_not_in_backup',
        `catalogued source has no bytes in the backup inventory: ${path}`, { path })
    const source = listed.get(sourcePath)
    if (source && source.sha256 !== file.sha256)
      error('source_checksum_index_mismatch',
        `catalogued source hash differs from the backup inventory: ${file.fileId}`,
        { fileId: file.fileId })
  }
  // Files present after a restore but absent from the manifest: legitimate new
  // uploads/builds, but they must not be mistaken for restored catalogue rows.
  for (const path of await listPersistentPaths(options.dataDir))
    if (!listed.has(path)) warn('unlisted_file', `file is not in the backup manifest: ${path}`, { path })

  // Dependency reconciliation against the live catalog.
  const current = await source.read()
  if (current.backend !== manifest.catalog.backend)
    error('backend_mismatch', `backup backend ${manifest.catalog.backend} does not match ${current.backend}`)
  const manifestFiles = new Map(manifest.catalog.files.map((file) => [file.fileId, file]))
  const currentFiles = new Map(current.files.map((file) => [file.fileId, file]))
  for (const file of manifest.catalog.files) {
    const live = currentFiles.get(file.fileId)
    if (!live) error('source_index_missing', `source index row was lost: ${file.fileId}`, { fileId: file.fileId })
    else if (live.sha256 !== file.sha256 || live.size !== file.size || live.format !== file.format)
      error('source_index_changed', `source index row changed: ${file.fileId}`, { fileId: file.fileId })
  }
  for (const fileId of new Set([...current.references, ...current.library.map((row) => row.fileId)])) {
    if (!currentFiles.has(fileId))
      error('file_reference_missing', `catalog references a missing source row: ${fileId}`, { fileId })
    else if (!manifestFiles.has(fileId))
      warn('source_added_after_backup', `source row was added after the backup: ${fileId}`, { fileId })
  }
  for (const row of manifest.catalog.library) {
    if (!current.library.some((live) => live.id === row.id && live.fileId === row.fileId))
      error('history_entry_missing', `saved history entry was lost: ${row.id}`, { fileId: row.fileId })
  }
  const currentArtifacts = new Map(current.artifacts.map((row) => [row.key, row]))
  const currentArchives = new Map(current.archives.map((row) => [row.key, row]))
  for (const row of manifest.catalog.artifacts) {
    const live = currentArtifacts.get(row.key)
    const tombstone = currentArchives.get(row.key)
    if (!live && !tombstone) error('catalog_row_missing', `artifact row was lost: ${row.key}`, { key: row.key })
    else if (live && (live.fileId !== row.fileId || live.generation < row.generation))
      error('catalog_generation_regressed', `artifact identity or high-water mark regressed: ${row.key}`, { key: row.key })
    else if (!live && tombstone && tombstone.generation < row.generation)
      error('catalog_generation_regressed', `tombstone high-water mark regressed: ${row.key}`, { key: row.key })
  }
  for (const tombstone of manifest.catalog.archives) {
    const live = currentArchives.get(tombstone.key)
    if (!live || live.generation < tombstone.generation)
      error('tombstone_lost', `generation tombstone was lost or regressed: ${tombstone.key}`, { key: tombstone.key })
  }
  for (const row of [...manifest.catalog.jobs, ...manifest.catalog.retirements,
    ...manifest.catalog.flatArchives])
    if (!currentArtifacts.has(row.key) && !currentArchives.has(row.key))
      error('dependency_missing', `artifact dependency lost its parent row: ${row.key}`, { key: row.key })
  for (const row of current.artifacts)
    if (!row.identityValid) error('catalog_identity_mismatch', `artifact identity does not derive its key: ${row.key}`, { key: row.key })

  // Every ready pointer must be proven against the manifest AND the live index.
  const readyVerified: string[] = []
  const blockedReady: BlockedReady[] = []
  let readyPointers = 0
  for (const row of current.artifacts) {
    if (!row.ready && !row.readyInvalid) continue
    readyPointers++
    if (row.readyInvalid) {
      error('invalid_ready_pointer', `ready pointer is malformed and cannot be proven: ${row.key}`, { key: row.key })
      continue
    }
    const ready = row.ready!
    const manifestPath = `${ready.storagePath}/manifest.json`
    const dataPath = `${ready.storagePath}/units.bin`
    let reason: string | undefined
    // A generation published after the backup is allowed, but then both bytes
    // must be hashed live and the manifest must match the registered digest.
    const listedFiles = [manifestPath, dataPath].filter((path) => listed.has(path))
    if (listedFiles.length && !listedFiles.every((path) => verified.has(path)))
      reason = 'generation bytes do not match the backup manifest'
    if (!reason) {
      if (!verified.has(manifestPath) && listedFiles.length === 0) {
        // Unlisted generation: verify both files live before opening it.
        try {
          for (const path of [manifestPath, dataPath]) {
            const digest = await digestFile(options.dataDir, path)
            if (path === manifestPath && digest.sha256 !== ready.manifestSha256)
              throw new ArtifactCorruptionError('unlisted manifest checksum mismatch')
            if (path === dataPath && digest.size === 0) reason = 'unlisted generation data is empty'
          }
        } catch (cause) {
          reason = cause instanceof Error ? cause.message : 'unlisted generation missing'
        }
      }
    }
    if (!reason) {
      try {
        const reader = await generations.open(ready)
        if (options.deep)
          for (const record of reader.manifest.records) await reader.read(record.id)
      } catch (cause) {
        reason = cause instanceof Error ? cause.message : 'generation verification failed'
      }
    }
    if (!reason) { readyVerified.push(ready.key); continue }

    let reconciled = false
    if (invalidate && catalog) {
      const withdrawn = await catalog.invalidateReady(ready)
      if (withdrawn) reconciled = true
      else {
        // False means the exact pointer was already replaced/cleared; confirm
        // that the catalogue no longer advertises this bad generation.
        const after = await source.read()
        const still = after.artifacts.find((entry) => entry.key === ready.key)?.ready
        reconciled = !still || still.generation !== ready.generation ||
          still.manifestSha256 !== ready.manifestSha256
      }
    }
    blockedReady.push({ key: ready.key, generation: ready.generation, reason, reconciled })
    if (!reconciled) error('ready_not_reconciled',
      `unverified ready pointer is still advertised: ${ready.key}`, { key: ready.key })
    else warn('ready_withdrawn', `withdrawn unverified ready pointer: ${ready.key} (${reason})`, { key: ready.key })
  }
  // A withdrawn pointer must not be re-advertised by a concurrent writer before
  // the service starts. The catalog's generation counter is monotonic, so the
  // same key+generation coming back means the bad bytes are still being offered.
  if (blockedReady.length && invalidate && catalog) {
    const after = await source.read()
    for (const blocked of blockedReady) {
      const still = after.artifacts.find((row) => row.key === blocked.key)?.ready
      if (still && still.generation === blocked.generation)
        error('ready_not_reconciled', `withdrawn ready pointer was re-advertised: ${blocked.key}`,
          { key: blocked.key })
    }
  }

  const counts = {
    entries: manifest.entries.length,
    sourceFiles: manifest.entries.filter((entry) => entry.kind === 'source').length,
    metadataFiles: manifest.entries.filter((entry) => entry.kind === 'metadata').length,
    artifactFiles: manifest.entries.filter((entry) => entry.kind === 'artifact').length,
    verifiedBytes,
    readyPointers,
  }
  return {
    ok: errors.length === 0,
    readyAllowed: errors.length === 0 && blockedReady.every((entry) => entry.reconciled),
    checkedAt: (options.now ?? Date.now)(),
    digest: manifest.digest,
    counts, errors, warnings, readyVerified, blockedReady,
  }
}
