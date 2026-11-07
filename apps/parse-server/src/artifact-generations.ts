import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { artifactGenerationPath, type ArtifactArchive, type MysqlArtifactCatalog, type ReadyArtifact } from './artifact-catalog'
import { ArtifactCorruptionError, ArtifactReader, ArtifactWriter, artifactKey, syncArtifactDirectory, type ArtifactIdentity } from './artifact-store'
import type { StorageBudget } from './storage-budget'

/** Immutable disk generations; readiness and lease fencing are managed by the catalog. */
export class ArtifactGenerations {
  constructor(readonly root: string, private readonly maxRecordBytes = 64 * 1024 * 1024,
    private readonly budget?: StorageBudget) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new Error('invalid artifact byte budget')
  }

  async publish(identity: ArtifactIdentity, generation: number,
    build: (writer: ArtifactWriter) => Promise<void>): Promise<ReadyArtifact> {
    const key = artifactKey(identity)
    const storagePath = artifactGenerationPath(key, generation)
    const destination = join(this.root, storagePath)
    await mkdir(dirname(destination), { recursive: true })
    // Exclusive reservation: rename alone would overwrite an existing EMPTY directory.
    await mkdir(destination)
    // Legacy age-only cleanup must not mistake a leased generation build for its own UUID staging.
    const staging = join(this.root, 'staging', `gen-${key}-g-${generation}-${randomUUID()}`)
    const reservation = this.budget?.reservation()
    let writer: ArtifactWriter | undefined
    try {
      await mkdir(staging, { recursive: true })
      writer = new ArtifactWriter(await open(join(staging, 'units.bin'), 'wx'), staging,
        destination, identity, this.maxRecordBytes, reservation, true)
      await build(writer)
      await writer.publish()
      // Persist fresh ancestor entries and both ends of the staging rename before SQL readiness.
      for (const directory of [destination, dirname(destination), dirname(dirname(destination)),
        join(this.root, 'artifacts'), join(this.root, 'staging'), this.root])
        await syncArtifactDirectory(directory)
      const manifestBytes = await readFile(join(destination, 'manifest.json'))
      const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
      const reader = await ArtifactReader.openDirectory(destination, key, this.maxRecordBytes, manifestSha256)
      return { key, generation, storagePath, manifestSha256,
        bytes: manifestBytes.length + reader.manifest.dataBytes,
        unitCount: reader.manifest.records.filter((record) => /^unit:\d+$/.test(record.id)).length }
    } catch (error) {
      await writer?.abort().catch(() => undefined)
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      // Never recursively delete the final path: a rename may already have succeeded.
      await rmdir(destination).catch(() => undefined)
      throw error
    } finally { await reservation?.release() }
  }

  async open(ready: ReadyArtifact,
    onCorruption?: (error: ArtifactCorruptionError) => void): Promise<ArtifactReader> {
    if (ready.storagePath !== artifactGenerationPath(ready.key, ready.generation) ||
        !/^[a-f0-9]{64}$/.test(ready.manifestSha256)) throw new Error('invalid generation pointer')
    const directory = join(this.root, ready.storagePath)
    const reader = await ArtifactReader.openDirectory(directory, ready.key, this.maxRecordBytes,
      ready.manifestSha256, onCorruption)
    const manifestSize = (await stat(join(directory, 'manifest.json'))).size
    if (manifestSize + reader.manifest.dataBytes !== ready.bytes ||
        reader.manifest.records.filter((record) => /^unit:\d+$/.test(record.id)).length !== ready.unitCount)
      throw new ArtifactCorruptionError('generation summary mismatch')
    return reader
  }

  async collect(key: string, generation: number,
    catalog: Pick<MysqlArtifactCatalog, 'retireGeneration'>): Promise<boolean> {
    const directory = join(this.root, artifactGenerationPath(key, generation))
    if (!await catalog.retireGeneration(key, generation)) return false
    await rm(directory, { recursive: true, force: true })
    await syncArtifactDirectory(dirname(directory)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return true
  }

  /**
   * Remove only the two top-level legacy flat files once the catalog has
   * irreversibly authorized their archive. The replacement generation must be
   * present and match the registered manifest before the old copy disappears.
   * Never recurses: g-N directories, unknown children and symlinks stay put.
   */
  async collectLegacyFlat(key: string,
    catalog: Pick<MysqlArtifactCatalog, 'authorizeFlatArchive'>): Promise<number> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid artifact key')
    const ready = await catalog.authorizeFlatArchive(key)
    if (!ready || ready.key !== key) return 0
    if (ready.storagePath !== artifactGenerationPath(key, ready.generation) ||
        !/^[a-f0-9]{64}$/.test(ready.manifestSha256))
      throw new Error('invalid legacy flat archive pointer')
    const directory = join(this.root, 'artifacts', key.slice(0, 2), key)
    const generationPath = join(this.root, ready.storagePath)
    const generationInfo = await lstat(generationPath)
    if (!generationInfo.isDirectory())
      throw new Error('legacy flat archive generation is not a directory')
    await ArtifactReader.openDirectory(generationPath, key, this.maxRecordBytes, ready.manifestSha256)

    // Validate every legacy file first: a non-regular path must not leave a
    // half-deleted flat layout behind after the first unlink succeeds.
    const targets: Array<{ path: string; bytes: number }> = []
    for (const name of ['manifest.json', 'units.bin']) {
      const path = join(directory, name)
      try {
        const info = await lstat(path)
        if (!info.isFile()) throw new Error('legacy flat path is not a regular file')
        targets.push({ path, bytes: info.size })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    let freed = 0
    for (const target of targets) {
      try {
        await unlink(target.path)
        freed += target.bytes
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // Another collector already removed it; only one process reports the bytes.
      }
    }
    await syncArtifactDirectory(directory)
    return freed
  }

  /**
   * Final filesystem cleanup after every generation/flat file is gone. Only a
   * canonical, non-symlink, literally empty key directory is eligible, and the
   * SQL transaction must have archived the directory row first. rmdir (rather
   * than a recursive rm) is atomic with respect to a concurrent publisher that
   * creates g-N under this key: ENOTEMPTY means somebody else won the race and
   * the freshly archived row will simply be re-created by their claim.
   */
  async collectEmptyKey(key: string,
    catalog: Pick<MysqlArtifactCatalog, 'archiveArtifact'>): Promise<ArtifactArchive | null> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid artifact key')
    const prefix = key.slice(0, 2)
    const artifactsRoot = join(this.root, 'artifacts')
    const bucket = join(artifactsRoot, prefix)
    const directory = join(bucket, key)
    const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info?.isDirectory()) return null
    if ((await readdir(directory)).length) return null
    const archived = await catalog.archiveArtifact(key, true)
    if (!archived || archived.key !== key) return null
    for (const path of [directory, bucket]) {
      try { await rmdir(path) }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOTEMPTY' && code !== 'ENOENT' && code !== 'EEXIST') throw error
      }
    }
    await syncArtifactDirectory(artifactsRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return archived
  }
}
