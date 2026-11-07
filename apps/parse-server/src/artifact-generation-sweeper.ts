import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { MysqlArtifactCatalog } from './artifact-catalog'
import { syncArtifactDirectory } from './artifact-store'
import type { ArtifactGenerations } from './artifact-generations'

interface Cursor { key: string; generation: number; staging?: string; flat?: boolean }
export interface GenerationSweepResult {
  examined: number
  collected: number
  protected: number
  young: number
  failed: number
  hasMore: boolean
  flatBytes: number
  flatCollected: number
  errors: Array<Cursor & { code: string }>
  stopped: boolean
}

/** Bounded, resumable discovery; only catalog transactions authorize deletion. */
export class ArtifactGenerationSweeper {
  private cursor?: Cursor
  private pending?: Promise<GenerationSweepResult>
  private stopped = false
  private closing?: Promise<void>

  constructor(private readonly disk: Pick<ArtifactGenerations, 'root' | 'collect' | 'collectLegacyFlat'>,
    private readonly catalog: Pick<MysqlArtifactCatalog, 'retireGeneration'>,
    private readonly flatCatalog?: Pick<MysqlArtifactCatalog, 'authorizeFlatArchive'>,
    private readonly onFlatCollected?: (key: string, bytes: number) => void) {}

  sweep(limit = 64, graceMs = 60 * 60_000): Promise<GenerationSweepResult> {
    if (this.stopped) throw new Error('generation sweeper closed')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4096 ||
        !Number.isSafeInteger(graceMs) || graceMs < 0) throw new Error('invalid generation sweep options')
    if (this.pending) return this.pending
    const work = Promise.resolve().then(() => this.run(limit, graceMs))
    this.pending = work
    void work.finally(() => { if (this.pending === work) this.pending = undefined }).catch(() => undefined)
    return work
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    this.closing = this.pending ? this.pending.then(() => undefined, () => undefined) : Promise.resolve()
    return this.closing
  }

  private async entries(path: string) {
    try { return await readdir(path, { withFileTypes: true }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async *generations(after?: Cursor): AsyncGenerator<Cursor & { modified: number }> {
    const root = join(this.disk.root, 'artifacts')
    const prefixes = (await this.entries(root)).filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const prefix of prefixes) {
      if (this.stopped) return
      if (after && prefix.name < after.key.slice(0, 2)) continue
      const bucket = join(root, prefix.name)
      const keys = (await this.entries(bucket)).filter((entry) => entry.isDirectory() &&
        /^[a-f0-9]{64}$/.test(entry.name) && entry.name.startsWith(prefix.name))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      for (const entry of keys) {
        if (this.stopped) return
        if (after && entry.name < after.key) continue
        const directory = join(bucket, entry.name)
        const generations = (await this.entries(directory)).filter((generation) => generation.isDirectory() &&
          /^g-[1-9][0-9]*$/.test(generation.name) && Number.isSafeInteger(Number(generation.name.slice(2))))
          .sort((a, b) => Number(a.name.slice(2)) - Number(b.name.slice(2)))
        for (const generation of generations) {
          if (this.stopped) return
          const number = Number(generation.name.slice(2))
          if (after?.key === entry.name && number <= after.generation) continue
          try {
            const info = await lstat(join(directory, generation.name))
            if (!info.isDirectory()) continue
            yield { key: entry.name, generation: number, modified: info.mtimeMs }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    }
  }

  private async *stagingCandidates(afterName?: string): AsyncGenerator<Cursor & { modified: number }> {
    const directory = join(this.disk.root, 'staging')
    const entries = (await this.entries(directory)).filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const entry of entries) {
      if (this.stopped) return
      if (afterName && entry.name <= afterName) continue
      const match = /^gen-([a-f0-9]{64})-g-([1-9][0-9]*)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.exec(entry.name)
      if (!match || !Number.isSafeInteger(Number(match[2]))) continue
      try {
        const info = await lstat(join(directory, entry.name))
        if (info.isDirectory()) yield { key: match[1], generation: Number(match[2]),
          staging: entry.name, modified: info.mtimeMs }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  /** Only canonical key directories with regular top-level flat files are candidates. */
  private async *flatCandidates(afterKey?: string): AsyncGenerator<Cursor & { modified: number }> {
    const root = join(this.disk.root, 'artifacts')
    const prefixes = (await this.entries(root)).filter((entry) => entry.isDirectory() && /^[a-f0-9]{2}$/.test(entry.name))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const prefix of prefixes) {
      if (this.stopped) return
      if (afterKey && prefix.name < afterKey.slice(0, 2)) continue
      const bucket = join(root, prefix.name)
      const keys = (await this.entries(bucket)).filter((entry) => entry.isDirectory() &&
        /^[a-f0-9]{64}$/.test(entry.name) && entry.name.startsWith(prefix.name))
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      for (const entry of keys) {
        if (this.stopped) return
        if (afterKey && entry.name <= afterKey) continue
        const directory = join(bucket, entry.name)
        let found = false
        let modified = 0
        for (const name of ['manifest.json', 'units.bin']) {
          try {
            const info = await lstat(join(directory, name))
            if (!info.isFile()) continue
            found = true
            modified = Math.max(modified, info.mtimeMs)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        if (found) yield { key: entry.name, generation: 0, flat: true, modified }
      }
    }
  }

  private async *candidates(after?: Cursor): AsyncGenerator<Cursor & { modified: number }> {
    if (!after?.staging && !after?.flat) yield* this.generations(after)
    if (this.stopped) return
    if (!after?.flat) yield* this.stagingCandidates(after?.staging)
    if (this.stopped) return
    yield* this.flatCandidates(after?.flat ? after.key : undefined)
  }

  private async collect(candidate: Cursor): Promise<{ collected: boolean; flatBytes: number }> {
    if (candidate.flat) {
      if (!this.flatCatalog) return { collected: false, flatBytes: 0 }
      const flatBytes = await this.disk.collectLegacyFlat(candidate.key, this.flatCatalog)
      return { collected: flatBytes > 0, flatBytes }
    }
    if (!candidate.staging)
      return { collected: await this.disk.collect(candidate.key, candidate.generation, this.catalog), flatBytes: 0 }
    // Retirement is irreversible and fences renew/complete before touching another process's staging.
    // Ready, unknown and live generations remain protected, regardless of directory age.
    if (!await this.catalog.retireGeneration(candidate.key, candidate.generation))
      return { collected: false, flatBytes: 0 }
    const directory = join(this.disk.root, 'staging')
    await rm(join(directory, candidate.staging), { recursive: true, force: true })
    await syncArtifactDirectory(directory)
    return { collected: true, flatBytes: 0 }
  }

  private async run(limit: number, graceMs: number): Promise<GenerationSweepResult> {
    const result: GenerationSweepResult = { examined: 0, collected: 0, protected: 0,
      young: 0, failed: 0, hasMore: false, flatBytes: 0, flatCollected: 0,
      errors: [], stopped: this.stopped }
    if (this.stopped) return result
    const cutoff = Date.now() - graceMs
    for await (const candidate of this.candidates(this.cursor)) {
      if (this.stopped) { result.stopped = true; return result }
      result.examined++
      if (candidate.modified > cutoff) result.young++
      else {
        try {
          const outcome = await this.collect(candidate)
          if (outcome.collected) result.collected++
          else result.protected++
          result.flatBytes += outcome.flatBytes
          if (outcome.flatBytes > 0) {
            result.flatCollected++
            // Observability only: a later pass can recompute the pending bytes.
            try { this.onFlatCollected?.(candidate.key, outcome.flatBytes) } catch { /* best effort */ }
          }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code
          result.failed++
          result.errors.push({ key: candidate.key, generation: candidate.generation,
            code: typeof code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(code) ? code : 'generation_collection_failed' })
        }
      }
      // Advance past protected/failed candidates too; retry them on the next complete pass.
      this.cursor = { key: candidate.key, generation: candidate.generation,
        staging: candidate.staging, flat: candidate.flat }
      if (this.stopped) { result.stopped = true; return result }
      if (result.examined >= limit) { result.hasMore = true; return result }
    }
    this.cursor = undefined
    result.stopped = this.stopped
    return result
  }
}
