import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { artifactGenerationPath, type ReadyArtifact } from '../src/artifact-catalog'
import { ArtifactGenerations } from '../src/artifact-generations'
import { canonicalJson, type ArtifactIdentity } from '../src/artifact-store'
import {
  BackupConcurrencyError, BackupManifestError, createBackupManifest,
  filesystemBackupCatalogSource, listPersistentPaths, verifyRestore,
  type BackupArtifactRow, type BackupCatalogSnapshot, type BackupCatalogSource,
  type BackupManifest,
} from '../src/backup-manifest'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

interface Fixture {
  dataDir: string
  sha: string
  sourceBytes: Buffer
  sourceSize: number
  sourcePath: string
  metaPath: string
  libraryPath: string
  identity: ArtifactIdentity
  ready: ReadyArtifact
  generations: ArtifactGenerations
  generationDir: string
  source: BackupCatalogSource
}

async function fixture(): Promise<Fixture> {
  const dataDir = await mkdtemp(join(tmpdir(), 'genoffice-backup-'))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const bytes = Buffer.from('the persisted source document bytes for restore drills')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const sourcePath = join(dataDir, 'files', sha.slice(0, 2), sha)
  const metaPath = join(dataDir, 'meta', `${sha}.json`)
  await mkdir(join(dataDir, 'files', sha.slice(0, 2)), { recursive: true })
  await mkdir(join(dataDir, 'meta'), { recursive: true })
  await writeFile(sourcePath, bytes)
  await writeFile(metaPath, JSON.stringify({ fileId: sha, sha256: sha, size: bytes.length,
    format: 'pptx', createdAt: '2026-11-09T00:00:00.000Z' }))
  const libraryPath = join(dataDir, 'library.json')
  await writeFile(libraryPath, JSON.stringify([{ id: randomUUID(), fileId: sha,
    displayName: 'saved.pptx', retention: 'saved', createdAt: 1, updatedAt: 1 }]))
  const identity: ArtifactIdentity = { fileId: sha, format: 'pptx',
    parserFingerprint: 'backup-manifest-test', schemaVersion: 1, options: {} }
  const generations = new ArtifactGenerations(dataDir)
  const ready = await generations.publish(identity, 1, async (writer) => {
    await writer.append('document', { slides: 1 })
    await writer.append('unit:0', { index: 0 })
  })
  return { dataDir, sha, sourceBytes: bytes, sourceSize: bytes.length,
    sourcePath, metaPath, libraryPath, identity, ready,
    generations, generationDir: join(dataDir, ready.storagePath),
    source: filesystemBackupCatalogSource(dataDir) }
}

/** A catalog with SQL-shaped rows, injected so ready fencing needs no database. */
function sqlSnapshot(f: Fixture, overrides: Partial<BackupCatalogSnapshot> = {}): BackupCatalogSnapshot {
  const artifact: BackupArtifactRow = { key: f.ready.key, fileId: f.sha, generation: 1,
    identityValid: true, ready: f.ready, readyInvalid: false }
  return {
    backend: 'mysql',
    files: [{ fileId: f.sha, sha256: f.sha, size: f.sourceSize, format: 'pptx' }],
    library: [], artifacts: [artifact], jobs: [{ key: f.ready.key, generation: 1 }],
    retirements: [], flatArchives: [], archives: [], references: [f.sha],
    ...overrides,
  }
}
function injectedSource(snapshot: BackupCatalogSnapshot,
  current?: BackupCatalogSnapshot | (() => BackupCatalogSnapshot),
  recheck = true) {
  const reading = current ?? snapshot
  const live = typeof reading === 'function' ? reading : () => reading
  const close = vi.fn(async () => undefined)
  const source: BackupCatalogSource = {
    backend: snapshot.backend,
    open: async () => ({ snapshot, recheck: async () => recheck, close }),
    read: async () => live(),
  }
  return { source, close }
}
function issueCodes(errors: Array<{ code: string }>): string[] {
  return errors.map((entry) => entry.code)
}

describe('consistent backup manifest', () => {
  it('records source, metadata and generation bytes, and a restore drill verifies them', async () => {
    const f = await fixture()
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: f.source })
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.catalog.backend).toBe('filesystem')
    const paths = manifest.entries.map((entry) => entry.path)
    expect(paths).toContain(`files/${f.sha.slice(0, 2)}/${f.sha}`)
    expect(paths).toContain(`meta/${f.sha}.json`)
    expect(paths).toContain('library.json')
    expect(paths).toContain(`${f.ready.storagePath}/manifest.json`)
    expect(paths).toContain(`${f.ready.storagePath}/units.bin`)
    expect(manifest.entries.every((entry) => entry.required === (entry.kind !== 'artifact'))).toBe(true)
    const report = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(report.ok).toBe(true)
    expect(report.readyAllowed).toBe(true)
    expect(report.counts.sourceFiles).toBe(1)
    expect(report.counts.metadataFiles).toBe(2)
    expect(report.counts.artifactFiles).toBe(2)
    expect(report.counts.verifiedBytes).toBeGreaterThan(0)
    expect(report.errors).toEqual([])
    // The drill is idempotent and does not mutate the store.
    expect((await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })).ok).toBe(true)
  })

  it('refuses a tampered or unknown manifest', async () => {
    const f = await fixture()
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: f.source })
    const altered = JSON.parse(JSON.stringify(manifest)) as BackupManifest
    altered.entries[0].sha256 = 'a'.repeat(64)
    await expect(verifyRestore({ dataDir: f.dataDir, manifest: altered, source: f.source }))
      .rejects.toBeInstanceOf(BackupManifestError)
    const wrongVersion = { ...manifest, schemaVersion: 99 } as unknown as BackupManifest
    await expect(verifyRestore({ dataDir: f.dataDir, manifest: wrongVersion, source: f.source }))
      .rejects.toBeInstanceOf(BackupManifestError)
    const badPath = JSON.parse(JSON.stringify(manifest)) as BackupManifest
    badPath.entries[0].path = '../etc/passwd'
    await expect(verifyRestore({ dataDir: f.dataDir, manifest: badPath, source: f.source }))
      .rejects.toBeInstanceOf(BackupManifestError)
  })

  it('fails the drill when a catalogued source has no bytes in the inventory', async () => {
    const f = await fixture()
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: f.source })
    const entries = manifest.entries.filter((entry) => entry.kind !== 'source')
    const reduced: BackupManifest = { ...manifest, entries,
      digest: createHash('sha256').update(canonicalJson({
        schemaVersion: 1, createdAt: manifest.createdAt,
        catalog: manifest.catalog, entries,
      })).digest('hex') }
    const report = await verifyRestore({ dataDir: f.dataDir, manifest: reduced, source: f.source })
    expect(issueCodes(report.errors)).toContain('source_not_in_backup')
    expect(report.ok).toBe(false)
    expect(report.readyAllowed).toBe(false)
  })

  it('fails closed for missing, altered or truncated source bytes and indexes', async () => {
    const f = await fixture()
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: f.source })
    await rm(f.sourcePath)
    const missing = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(missing.ok).toBe(false)
    expect(missing.readyAllowed).toBe(false)
    expect(issueCodes(missing.errors)).toContain('source_missing')

    await writeFile(f.sourcePath, Buffer.alloc(f.sourceSize, 0x41))
    const altered = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(altered.ok).toBe(false)
    expect(issueCodes(altered.errors)).toContain('source_checksum_mismatch')
    expect(f.sha).toBe(createHash('sha256').update(f.sourceBytes).digest('hex'))
    await rm(f.metaPath)
    const noIndex = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(issueCodes(noIndex.errors)).toContain('metadata_missing')
  })

  it('treats missing or corrupted generation files as rebuildable warnings', async () => {
    const f = await fixture()
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: f.source })
    const dataPath = join(f.generationDir, 'units.bin')
    const original = await readFile(dataPath)
    await writeFile(dataPath, Buffer.from(original).fill(0x42, 0, 1))
    const altered = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(altered.ok).toBe(true)
    expect(altered.warnings.some((issue) => issue.code === 'artifact_checksum_mismatch')).toBe(true)
    await rm(dataPath)
    const missing = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(missing.ok).toBe(true)
    expect(missing.warnings.some((issue) => issue.code === 'artifact_missing')).toBe(true)
    expect(await listPersistentPaths(f.dataDir)).not.toContain(`${f.ready.storagePath}/units.bin`)
  })

  it('refuses to snapshot an inconsistent filesystem index', async () => {
    const f = await fixture()
    await writeFile(f.libraryPath, JSON.stringify([{ id: randomUUID(),
      fileId: 'b'.repeat(64), displayName: 'dangling', retention: 'saved',
      createdAt: 1, updatedAt: 1 }]))
    await expect(createBackupManifest({ dataDir: f.dataDir, source: f.source }))
      .rejects.toThrow(/dangling.*reference/)
    await writeFile(f.libraryPath, JSON.stringify([]))
    await writeFile(f.metaPath, JSON.stringify({ fileId: f.sha, sha256: 'c'.repeat(64),
      size: 48, format: 'pptx' }))
    await expect(createBackupManifest({ dataDir: f.dataDir, source: f.source }))
      .rejects.toThrow(/invalid file metadata entry/)
  })

  it('refuses a manifest when the catalog changes while files are hashed', async () => {
    const f = await fixture()
    const { source, close } = injectedSource(await f.source.read(), undefined, false)
    await expect(createBackupManifest({ dataDir: f.dataDir, source }))
      .rejects.toBeInstanceOf(BackupConcurrencyError)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('flags extra durable files and a backend mismatch', async () => {
    const f = await fixture()
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: f.source })
    const extra = 'd'.repeat(64)
    await writeFile(join(f.dataDir, 'meta', `${extra}.json`), JSON.stringify({
      fileId: extra, sha256: extra, size: 1, format: 'pptx' }))
    const report = await verifyRestore({ dataDir: f.dataDir, manifest, source: f.source })
    expect(report.warnings.some((issue) => issue.code === 'unlisted_file')).toBe(true)
    const mysql = injectedSource({ ...manifest.catalog, backend: 'mysql', artifacts: [] })
    const mismatched = await verifyRestore({ dataDir: f.dataDir, manifest, source: mysql.source })
    expect(issueCodes(mismatched.errors)).toContain('backend_mismatch')
  })
})

describe('recovery drill with SQL-shaped catalog rows', () => {
  async function sqlFixture() {
    const f = await fixture()
    const snapshot = sqlSnapshot(f)
    const injected = injectedSource(snapshot)
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: injected.source })
    expect(manifest.catalog.artifacts).toHaveLength(1)
    return { f, snapshot, injected, manifest }
  }

  it('proves every ready pointer against the manifest before allowing readiness', async () => {
    const { f, injected, manifest } = await sqlFixture()
    const report = await verifyRestore({ dataDir: f.dataDir, manifest,
      source: injected.source, generations: f.generations, deep: true })
    expect(report.ok).toBe(true)
    expect(report.readyAllowed).toBe(true)
    expect(report.counts.readyPointers).toBe(1)
    expect(report.readyVerified).toEqual([f.ready.key])
    expect(report.blockedReady).toEqual([])
  })

  it('withdraws a ready pointer whose generation bytes no longer match', async () => {
    const { f, snapshot, manifest } = await sqlFixture()
    await rm(join(f.generationDir, 'units.bin'))
    let live: BackupCatalogSnapshot = snapshot
    const source: BackupCatalogSource = {
      backend: 'mysql',
      open: async () => ({ snapshot, recheck: async () => true, close: async () => undefined }),
      read: async () => live,
    }
    const invalidateReady = vi.fn(async () => {
      live = { ...snapshot, artifacts: [{ ...snapshot.artifacts[0], ready: null }] }
      return true
    })
    const report = await verifyRestore({ dataDir: f.dataDir, manifest,
      source, generations: f.generations, catalog: { invalidateReady } })
    expect(invalidateReady).toHaveBeenCalledWith(f.ready)
    expect(report.blockedReady).toHaveLength(1)
    expect(report.blockedReady[0]).toMatchObject({ key: f.ready.key, reconciled: true })
    expect(report.ok).toBe(true)
    expect(report.readyAllowed).toBe(true)
    expect(report.warnings.some((issue) => issue.code === 'ready_withdrawn')).toBe(true)
  })

  it('fails closed when a bad ready pointer cannot be withdrawn', async () => {
    const { f, injected, manifest } = await sqlFixture()
    await rm(join(f.generationDir, 'manifest.json'))
    const readonly = await verifyRestore({ dataDir: f.dataDir, manifest,
      source: injected.source, generations: f.generations, invalidate: false })
    expect(readonly.ok).toBe(false)
    expect(readonly.readyAllowed).toBe(false)
    expect(issueCodes(readonly.errors)).toContain('ready_not_reconciled')

    const refused = await verifyRestore({ dataDir: f.dataDir, manifest,
      source: injected.source, generations: f.generations,
      catalog: { invalidateReady: async () => false } })
    expect(refused.ok).toBe(false)
    expect(issueCodes(refused.errors)).toContain('ready_not_reconciled')
  })

  it('accepts a concurrently cleared pointer as reconciled', async () => {
    const { f, snapshot, manifest } = await sqlFixture()
    await rm(join(f.generationDir, 'units.bin'))
    const cleared: BackupCatalogSnapshot = { ...snapshot,
      artifacts: [{ ...snapshot.artifacts[0], ready: null }] }
    let reads = 0
    const source: BackupCatalogSource = {
      backend: 'mysql',
      open: async () => ({ snapshot, recheck: async () => true, close: async () => undefined }),
      // First read sees the bad pointer; the recheck after a failed compare-and-clear
      // sees that another process already withdrew it.
      read: async () => (++reads === 1 ? snapshot : cleared),
    }
    const report = await verifyRestore({ dataDir: f.dataDir, manifest, source,
      generations: f.generations, catalog: { invalidateReady: async () => false } })
    expect(reads).toBeGreaterThanOrEqual(2)
    expect(report.ok).toBe(true)
    expect(report.blockedReady[0].reconciled).toBe(true)
  })

  it('a deep drill detects a frame corrupted before the manifest was taken', async () => {
    const f = await fixture()
    const dataPath = join(f.generationDir, 'units.bin')
    const original = await readFile(dataPath)
    const damaged = Buffer.from(original)
    damaged[damaged.length - 1] ^= 0xff
    await writeFile(dataPath, damaged)
    const snapshot = sqlSnapshot(f)
    const injected = injectedSource(snapshot)
    // Re-snapshotting would bless the damaged bytes, so the full-file hashes
    // alone cannot detect it. Only the per-frame gzip/sha256 deep check can.
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: injected.source })
    const shallow = await verifyRestore({ dataDir: f.dataDir, manifest,
      source: injected.source, generations: f.generations })
    expect(shallow.readyVerified).toEqual([f.ready.key])
    const deep = await verifyRestore({ dataDir: f.dataDir, manifest,
      source: injected.source, generations: f.generations, deep: true,
      catalog: { invalidateReady: async () => true } })
    expect(deep.blockedReady).toHaveLength(1)
    expect(deep.readyVerified).toEqual([])
    // The injected catalog keeps advertising the bad generation after the
    // withdrawal: the post-withdrawal recheck must refuse readiness again.
    expect(issueCodes(deep.errors)).toContain('ready_not_reconciled')
  })

  it('detects an unlisted generation published after the backup', async () => {
    const f = await fixture()
    const snapshot = sqlSnapshot(f)
    const injected = injectedSource(snapshot)
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: injected.source })
    const entries = manifest.entries.filter((entry) => entry.kind !== 'artifact')
    // Deliberately omit the generation bytes so verification must hash them live.
    const withoutArtifacts: BackupManifest = { ...manifest, entries,
      digest: createHash('sha256').update(canonicalJson({
        schemaVersion: 1, createdAt: manifest.createdAt,
        catalog: manifest.catalog, entries,
      })).digest('hex') }
    const report = await verifyRestore({ dataDir: f.dataDir, manifest: withoutArtifacts,
      source: injected.source, generations: f.generations })
    expect(report.readyVerified).toEqual([f.ready.key])
    expect(report.warnings.some((issue) => issue.code === 'unlisted_file')).toBe(true)
  })

  it('reconciles lost source rows, history, tombstones and dependencies', async () => {
    const f = await fixture()
    const snapshot = sqlSnapshot(f, {
      library: [{ id: randomUUID(), fileId: f.sha }],
      archives: [{ key: f.ready.key, fileId: f.sha, generation: 7 }],
      jobs: [{ key: f.ready.key, generation: 1 }],
    })
    const injected = injectedSource(snapshot)
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: injected.source })
    const lost: BackupCatalogSnapshot = {
      ...snapshot, files: [], library: [], artifacts: [],
      archives: [], references: [],
    }
    const broken = injectedSource(snapshot, lost)
    const report = await verifyRestore({ dataDir: f.dataDir, manifest,
      source: broken.source, generations: f.generations })
    expect(report.ok).toBe(false)
    expect(report.readyAllowed).toBe(false)
    const codes = issueCodes(report.errors)
    expect(codes).toContain('source_index_missing')
    expect(codes).toContain('history_entry_missing')
    expect(codes).toContain('catalog_row_missing')
    expect(codes).toContain('tombstone_lost')
    expect(codes).toContain('dependency_missing')
  })

  it('rejects a malformed ready pointer and an identity that no longer derives its key', async () => {
    const f = await fixture()
    const snapshot = sqlSnapshot(f)
    const injected = injectedSource(snapshot)
    const manifest = await createBackupManifest({ dataDir: f.dataDir, source: injected.source })
    const malformed: BackupCatalogSnapshot = { ...snapshot,
      artifacts: [{ ...snapshot.artifacts[0], ready: null, readyInvalid: true,
        identityValid: false }] }
    const { source } = injectedSource(snapshot, malformed)
    const report = await verifyRestore({ dataDir: f.dataDir, manifest, source,
      generations: f.generations })
    expect(issueCodes(report.errors)).toContain('invalid_ready_pointer')
    expect(issueCodes(report.errors)).toContain('catalog_identity_mismatch')
    expect(report.ok).toBe(false)
  })

  it('rejects a snapshot whose generation path does not match its key', async () => {
    const f = await fixture()
    const wrong: ReadyArtifact = { ...f.ready,
      storagePath: artifactGenerationPath('e'.repeat(64), 1) }
    const snapshot = sqlSnapshot(f, { artifacts: [{ key: f.ready.key, fileId: f.sha,
      generation: 1, identityValid: true, ready: wrong, readyInvalid: false }] })
    const { source } = injectedSource(snapshot)
    await expect(createBackupManifest({ dataDir: f.dataDir, source }))
      .rejects.toThrow(/invalid generation path/)
  })
})
