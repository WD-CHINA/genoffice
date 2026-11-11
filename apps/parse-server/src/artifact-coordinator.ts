import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { MysqlArtifactCatalog, ArtifactLease } from './artifact-catalog'
import type { ArtifactGenerations } from './artifact-generations'
import { ArtifactCorruptionError, artifactKey, type ArtifactIdentity, type ArtifactReader, type ArtifactWriter } from './artifact-store'
import { observeUntilAbort as abortable } from './artifact-signals'
import { isRecoverableInfrastructureError, retryDelayMs } from './retry-policy'

type Catalog = Pick<MysqlArtifactCatalog, 'leaseMs' | 'claim' | 'renew' | 'complete' | 'fail'>
  & Partial<Pick<MysqlArtifactCatalog, 'invalidateReady' | 'cancel'>>
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
  readonly stats = { retries: 0 }

  private readonly maxRetries: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number

  constructor(private readonly catalog: Catalog, private readonly disk: Disk,
    private readonly pollMs = 250, private readonly maxWaitMs = 10 * 60_000,
    retry: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {}) {
    for (const value of [pollMs, maxWaitMs, catalog.leaseMs])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error('invalid artifact coordinator timing')
    this.maxRetries = retry.attempts ?? 2
    this.retryBaseMs = retry.baseDelayMs ?? 50
    this.retryMaxMs = retry.maxDelayMs ?? 2000
    for (const value of [this.maxRetries, this.retryBaseMs, this.retryMaxMs])
      if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647)
        throw new Error('invalid artifact coordinator retry policy')
  }

  getOrBuild(identity: ArtifactIdentity,
    build: (writer: ArtifactWriter, signal: AbortSignal, jobId: string) => Promise<void>,
    readerSignal?: AbortSignal, onWaiting?: () => void,
    demand?: AbortSignal): Promise<ArtifactReader> {
    this.stopped.signal.throwIfAborted()
    readerSignal?.throwIfAborted()
    const key = artifactKey(identity)
    let task = this.pending.get(key)
    if (!task) {
      task = Promise.resolve().then(async () => {
        const deadline = performance.now() + this.maxWaitMs
        let repaired = false
        let retries = 0
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
          if (claim.kind === 'acquired') {
            try {
              return await this.buildOwned(identity, claim.lease, started, build, demand)
            } catch (error) {
              this.stopped.signal.throwIfAborted()
              if (retries >= this.maxRetries || !isRecoverableInfrastructureError(error))
                throw error
              retries++
              this.stats.retries++
              await delay(retryDelayMs(retries, this.retryBaseMs, this.retryMaxMs), undefined,
                { signal: this.stopped.signal })
              continue
            }
          }
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
    build: (writer: ArtifactWriter, signal: AbortSignal, jobId: string) => Promise<void>,
    demand?: AbortSignal): Promise<ArtifactReader> {
    const lost = new AbortController()
    // Plan §6: demand aborts only after the last waiter leaves (server-side),
    // never from one viewer closing while others still read the same artifact.
    const signal = AbortSignal.any([lost.signal, this.stopped.signal,
      ...(demand ? [demand] : [])])
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
        await build(writer, signal, lease.jobId)
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
      // Plan §6: a deliberate abort (shutdown) is a cancellation, while lease
      // loss or a real build error stays failed/build_interrupted.
      const reason = signal.aborted ? signal.reason as { name?: string } | undefined : undefined
      const cancelled = reason?.name === 'AbortError' && this.catalog.cancel
      const outcome = cancelled
        ? this.catalog.cancel!(lease, 'build_cancelled')
        : this.catalog.fail(lease, signal.aborted ? 'build_interrupted' : 'build_failed')
      await outcome.catch(() => undefined)
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
