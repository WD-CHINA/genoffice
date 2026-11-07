import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { artifactGenerationPath, type MysqlArtifactCatalog, type ReadyArtifact } from './artifact-catalog'
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
}
