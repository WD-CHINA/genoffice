import { setTimeout as delay } from 'node:timers/promises'
import type { ArtifactReadLease, MysqlArtifactCatalog, ReadyArtifact } from './artifact-catalog'
import type { ArtifactGenerations } from './artifact-generations'
import { ArtifactCorruptionError, type ArtifactReader } from './artifact-store'
import { observeUntilAbort } from './artifact-signals'
import { logEvent } from './telemetry'

type Catalog = Pick<MysqlArtifactCatalog, 'leaseMs' | 'pin' | 'renewRead' | 'releaseRead'>
  & Partial<Pick<MysqlArtifactCatalog, 'forkRead' | 'invalidateReady'>>
type Disk = Pick<ArtifactGenerations, 'open'>

export class ArtifactReadLeaseLostError extends Error {
  readonly code = 'artifact_read_lease_lost'
  constructor(options?: ErrorOptions) { super('artifact reader lease lost', options) }
}

/** A view owns this handle; it never exposes an unguarded underlying reader. */
export class ArtifactReadHandle {
  readonly artifact: Readonly<ReadyArtifact>
  private readonly controller = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private readonly heartbeat: Promise<void>
  private watchdog?: ReturnType<typeof setTimeout>
  private deadline = 0
  private reader?: ArtifactReader
  private closing?: Promise<void>
  private corruptionReported?: Promise<void>

  static async open(catalog: Catalog, disk: Disk, key: string, owner: string,
    durationMs = catalog.leaseMs): Promise<ArtifactReadHandle | null> {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 600_000)
      throw new Error('invalid artifact read handle duration')
    const started = performance.now()
    const pinned = await catalog.pin(key, owner, durationMs)
    if (!pinned) return null
    const handle = new ArtifactReadHandle(catalog, pinned.lease, pinned.artifact, durationMs, started)
    try {
      handle.check()
      // Lazy frame checksum failures are reported against THIS exact generation,
      // so only a matching ready pointer can ever be withdrawn.
      handle.reader = await observeUntilAbort(
        disk.open(pinned.artifact, (error) => { void handle.reportCorruption(error) }),
        handle.signal,
      )
      handle.check()
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  private constructor(private readonly catalog: Catalog, private readonly lease: ArtifactReadLease,
    artifact: ReadyArtifact, private readonly durationMs: number, started: number) {
    this.artifact = Object.freeze({ ...artifact })
    this.heartbeat = this.renewLoop()
    this.confirm(started)
    this.signal.addEventListener('abort', () => { void this.close().catch(() => undefined) }, { once: true })
  }

  get signal(): AbortSignal { return this.controller.signal }

  /** Withdraw only the exact ready pointer this reader observed as damaged. */
  reportCorruption(error: ArtifactCorruptionError): Promise<void> {
    if (!this.corruptionReported) {
      this.corruptionReported = (async () => {
        if (!this.catalog.invalidateReady) return
        try { await this.catalog.invalidateReady(this.artifact) }
        catch (cause) {
          logEvent('warn', 'artifact_corruption_report_failed', {
            artifactKey: this.artifact.key,
            generation: this.artifact.generation,
            message: error.message,
            cause: cause instanceof Error ? cause.message : String(cause),
          })
        }
      })()
    }
    return this.corruptionReported
  }

  private confirm(started: number): void {
    if (this.signal.aborted) return
    clearTimeout(this.watchdog)
    this.deadline = started + this.durationMs
    const remaining = this.deadline - performance.now()
    if (remaining <= 0) this.controller.abort(new ArtifactReadLeaseLostError())
    else this.watchdog = setTimeout(() => this.controller.abort(new ArtifactReadLeaseLostError()), remaining)
  }

  private check(): void {
    if (!this.signal.aborted && performance.now() >= this.deadline)
      this.controller.abort(new ArtifactReadLeaseLostError())
    this.signal.throwIfAborted()
  }

  private async renewLoop(): Promise<void> {
    try {
      while (!this.signal.aborted) {
        await delay(Math.max(1, Math.floor(this.durationMs / 3)), undefined, { signal: this.signal })
        const started = performance.now()
        if (!await observeUntilAbort(this.catalog.renewRead(this.lease, this.durationMs), this.signal)) {
          this.controller.abort(new ArtifactReadLeaseLostError())
          return
        }
        this.confirm(started)
      }
    } catch (cause) {
      if (!this.signal.aborted) this.controller.abort(new ArtifactReadLeaseLostError({ cause }))
    }
  }

  get manifest() { this.check(); return this.reader!.manifest }
  get contentDigest(): string { this.check(); return this.reader!.contentDigest }
  has(id: string): boolean { this.check(); return this.reader!.has(id) }
  describe(id: string): { size: number; sha256: string } { this.check(); return this.reader!.describe(id) }

  /** Independently own this exact immutable generation, including after ready pointer replacement. */
  async fork(owner: string): Promise<ArtifactReadHandle> {
    this.check()
    if (!this.catalog.forkRead) throw new Error('artifact dependency pins unsupported')
    const reader = this.reader!
    const started = performance.now()
    const lease = await this.catalog.forkRead(this.lease, owner, this.durationMs)
    if (!lease) throw new ArtifactReadLeaseLostError()
    const handle = new ArtifactReadHandle(this.catalog, lease, this.artifact, this.durationMs, started)
    try {
      handle.check()
      handle.reader = reader
      return handle
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  /** Keep the generation pinned until external work (including worker termination) actually settles. */
  async use<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check()
    const work = operation(this.signal)
    this.active.add(work)
    void work.finally(() => this.active.delete(work)).catch(() => undefined)
    const result = await observeUntilAbort(work, this.signal)
    this.check()
    return result
  }

  async read(id: string): ReturnType<ArtifactReader['read']> {
    return this.use(async () => {
      try { return await this.reader!.read(id) }
      catch (error) {
        // Forked handles share the parent's reader and therefore its callback;
        // always report against this handle's own generation pin as well.
        if (error instanceof ArtifactCorruptionError) await this.reportCorruption(error)
        throw error
      }
    })
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closing = Promise.resolve().then(async () => {
      await this.heartbeat
      await Promise.allSettled([...this.active])
      await this.corruptionReported
      try { await this.catalog.releaseRead(this.lease) }
      finally { this.reader = undefined }
    })
    clearTimeout(this.watchdog)
    this.controller.abort(new DOMException('Artifact reader closed', 'AbortError'))
    return this.closing
  }
}
