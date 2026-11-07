import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { MysqlArtifactCatalog, ArtifactLease } from './artifact-catalog'
import type { ArtifactGenerations } from './artifact-generations'
import { ArtifactCorruptionError, artifactKey, type ArtifactIdentity, type ArtifactReader, type ArtifactWriter } from './artifact-store'
import { observeUntilAbort as abortable } from './artifact-signals'

type Catalog = Pick<MysqlArtifactCatalog, 'leaseMs' | 'claim' | 'renew' | 'complete' | 'fail'>
  & Partial<Pick<MysqlArtifactCatalog, 'invalidateReady'>>
type Disk = Pick<ArtifactGenerations, 'publish' | 'open'>

export class ArtifactLeaseLostError extends Error {
  readonly code = 'artifact_lease_lost'
  constructor(options?: ErrorOptions) { super('artifact build lease lost', options) }
}
export class ArtifactWaitTimeoutError extends Error {
  readonly code = 'artifact_wait_timeout'
  constructor() { super('timed out waiting for shared artifact') }
}

/** Catalog/generation orchestration. A build callback must cooperate with its abort signal. */
export class ArtifactCoordinator {
  private readonly owner = randomUUID()
  private readonly stopped = new AbortController()
  private readonly pending = new Map<string, Promise<ArtifactReader>>()

  constructor(private readonly catalog: Catalog, private readonly disk: Disk,
    private readonly pollMs = 250, private readonly maxWaitMs = 10 * 60_000) {
    for (const value of [pollMs, maxWaitMs, catalog.leaseMs])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error('invalid artifact coordinator timing')
  }

  getOrBuild(identity: ArtifactIdentity,
    build: (writer: ArtifactWriter, signal: AbortSignal) => Promise<void>,
    readerSignal?: AbortSignal, onWaiting?: () => void): Promise<ArtifactReader> {
    this.stopped.signal.throwIfAborted()
    readerSignal?.throwIfAborted()
    const key = artifactKey(identity)
    let task = this.pending.get(key)
    if (!task) {
      task = Promise.resolve().then(async () => {
        const deadline = performance.now() + this.maxWaitMs
        let repaired = false
        for (;;) {
          this.stopped.signal.throwIfAborted()
          const started = performance.now()
          const claim = await abortable(this.catalog.claim(identity, this.owner), this.stopped.signal)
          if (claim.kind === 'ready') {
            try { return await this.disk.open(claim.artifact) }
            catch (error) {
              if (!(error instanceof ArtifactCorruptionError) || repaired || !this.catalog.invalidateReady) throw error
              await abortable(this.catalog.invalidateReady(claim.artifact), this.stopped.signal)
              repaired = true
              continue
            }
          }
          if (claim.kind === 'acquired') return this.buildOwned(identity, claim.lease, started, build)
          onWaiting?.()
          const remaining = deadline - performance.now()
          if (remaining <= 0) throw new ArtifactWaitTimeoutError()
          await delay(Math.min(this.pollMs, remaining), undefined, { signal: this.stopped.signal })
        }
      })
      this.pending.set(key, task)
      const current = task
      void task.finally(() => {
        if (this.pending.get(key) === current) this.pending.delete(key)
      }).catch(() => undefined)
    } else onWaiting?.()
    return abortable(task, readerSignal
      ? AbortSignal.any([readerSignal, this.stopped.signal]) : this.stopped.signal)
  }

  private async buildOwned(identity: ArtifactIdentity, lease: ArtifactLease, claimStarted: number,
    build: (writer: ArtifactWriter, signal: AbortSignal) => Promise<void>): Promise<ArtifactReader> {
    const lost = new AbortController()
    const signal = AbortSignal.any([lost.signal, this.stopped.signal])
    const heartbeatStop = new AbortController()
    const heartbeatSignal = AbortSignal.any([heartbeatStop.signal, signal])
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const confirm = (started: number) => {
      clearTimeout(watchdog)
      // Count the entire SQL round trip conservatively, using a monotonic local clock.
      const remaining = this.catalog.leaseMs - (performance.now() - started)
      if (remaining <= 0) lost.abort(new ArtifactLeaseLostError())
      else watchdog = setTimeout(() => lost.abort(new ArtifactLeaseLostError()), remaining)
    }
    confirm(claimStarted)
    const heartbeat = (async () => {
      try {
        while (!heartbeatSignal.aborted) {
          await delay(Math.max(1, Math.floor(this.catalog.leaseMs / 3)), undefined, { signal: heartbeatSignal })
          const started = performance.now()
          const renewed = await abortable(this.catalog.renew(lease), heartbeatSignal)
          if (!renewed) { lost.abort(new ArtifactLeaseLostError()); return }
          confirm(started)
        }
      } catch (cause) {
        if (!heartbeatSignal.aborted) lost.abort(new ArtifactLeaseLostError({ cause }))
      }
    })()
    try {
      signal.throwIfAborted()
      const published = await this.disk.publish(identity, lease.generation, async (writer) => {
        signal.throwIfAborted()
        await build(writer, signal)
        signal.throwIfAborted()
      })
      heartbeatStop.abort()
      await heartbeat
      signal.throwIfAborted()
      const started = performance.now()
      if (!await abortable(this.catalog.renew(lease), signal)) throw new ArtifactLeaseLostError()
      confirm(started)
      signal.throwIfAborted()
      if (!await abortable(this.catalog.complete(lease, published), signal)) throw new ArtifactLeaseLostError()
      clearTimeout(watchdog)
      // Never delete a generation on false/ambiguous SQL completion: it may already be ready.
      return await abortable(this.disk.open(published), signal)
    } catch (error) {
      await this.catalog.fail(lease, signal.aborted ? 'build_interrupted' : 'build_failed').catch(() => undefined)
      throw signal.aborted ? signal.reason : error
    } finally {
      clearTimeout(watchdog)
      heartbeatStop.abort()
      await heartbeat
    }
  }

  async close(): Promise<void> {
    this.stopped.abort(new DOMException('Artifact coordinator closed', 'AbortError'))
    await Promise.allSettled([...this.pending.values()])
  }
}
