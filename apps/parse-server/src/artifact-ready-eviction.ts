import type { MysqlArtifactCatalog } from './artifact-catalog'
import type { ArtifactGenerations } from './artifact-generations'

export interface ReadyEvictionResult {
  requestedBytes: number
  pendingBytes: number
  examined: number
  withdrawn: number
  collected: number
  bytesFreed: number
  protected: number
  failed: number
  hasMore: boolean
  errors: string[]
}
export interface ReadyEvictionSnapshot {
  pendingBytes: number
  rounds: number
  totalWithdrawn: number
  totalCollected: number
  totalBytes: number
  lastResult?: ReadyEvictionResult
}
export interface ReadyEvictionOptions {
  /** A generation touched more recently than this is not a reclaim candidate. */
  idleMs?: number
  /** Maximum ready rows examined in one background pass. */
  batchSize?: number
  /** Prove the source document is still on disk before withdrawing its cache. */
  sourceExists: (fileId: string) => Promise<boolean>
  onReclaimed?: (result: ReadyEvictionResult) => void
}
type EvictionCatalog = Pick<MysqlArtifactCatalog,
  'listReadyEvictionCandidates' | 'withdrawReady' | 'retireGeneration'>

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(code)
    ? code : 'ready_eviction_failed'
}

/**
 * Reclaims *rebuildable* ready generations when the shared storage budget is
 * past its high watermark. The source document, library history and generation
 * counter survive; only the derived generation bytes are withdrawn and removed.
 *
 * Two-phase by design: `request()` runs inside the storage admission GET_LOCK
 * and must never touch SQL, while `run()` executes the catalog transactions in
 * the background sweeper, outside that lock. Concurrent instances race on the
 * same SQL rows; compare-and-clear plus irreversible retirement authorisation
 * make a duplicate pass harmless.
 */
export class ArtifactReadyEviction {
  private readonly idleMs: number
  private readonly batchSize: number
  private pendingBytes = 0
  private rounds = 0
  private totalWithdrawn = 0
  private totalCollected = 0
  private totalBytes = 0
  private lastResult?: ReadyEvictionResult
  private running?: Promise<ReadyEvictionResult>
  private stopped = false

  constructor(
    private readonly catalog: EvictionCatalog,
    private readonly disk: Pick<ArtifactGenerations, 'collect'>,
    private readonly options: ReadyEvictionOptions,
  ) {
    this.idleMs = options.idleMs ?? 60_000
    this.batchSize = options.batchSize ?? 16
    if (!Number.isSafeInteger(this.idleMs) || this.idleMs < 0 || this.idleMs > 2_147_483_647 ||
        !Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 4096)
      throw new Error('invalid ready eviction options')
    if (typeof options.sourceExists !== 'function') throw new Error('missing source existence probe')
  }

  /** In-memory only. Safe to call while holding the shared admission lock. */
  request(bytes: number): void {
    if (this.stopped || !Number.isSafeInteger(bytes) || bytes <= 0) return
    // Coalesce concurrent pressure signals; every write does not add a new debt.
    this.pendingBytes = Math.max(this.pendingBytes, bytes)
    this.rounds++
  }

  get snapshot(): ReadyEvictionSnapshot {
    return { pendingBytes: this.pendingBytes, rounds: this.rounds,
      totalWithdrawn: this.totalWithdrawn, totalCollected: this.totalCollected,
      totalBytes: this.totalBytes, ...(this.lastResult ? { lastResult: this.lastResult } : {}) }
  }

  /** Runs outside the admission lock. Concurrent callers share one pass. */
  run(): Promise<ReadyEvictionResult> {
    if (this.running) return this.running
    const work = this.reclaim()
    this.running = work
    void work.finally(() => { if (this.running === work) this.running = undefined })
      .catch(() => undefined)
    return work
  }

  close(): void { this.stopped = true }

  private empty(requestedBytes: number): ReadyEvictionResult {
    return { requestedBytes, pendingBytes: this.pendingBytes, examined: 0,
      withdrawn: 0, collected: 0, bytesFreed: 0, protected: 0,
      failed: 0, hasMore: false, errors: [] }
  }

  private async reclaim(): Promise<ReadyEvictionResult> {
    const requestedBytes = this.pendingBytes
    const result = this.empty(requestedBytes)
    if (this.stopped || requestedBytes <= 0) {
      this.lastResult = result
      return result
    }
    let candidates: Awaited<ReturnType<EvictionCatalog['listReadyEvictionCandidates']>>
    try {
      candidates = await this.catalog.listReadyEvictionCandidates(this.batchSize, this.idleMs)
    } catch (error) {
      result.failed++
      result.errors.push(errorCode(error))
      this.lastResult = result
      return result
    }
    for (const candidate of candidates) {
      if (this.stopped || result.bytesFreed >= requestedBytes) break
      result.examined++
      const { artifact, fileId } = candidate
      try {
        // A cache is expendable only while its source can still rebuild it.
        if (!await this.options.sourceExists(fileId)) { result.protected++; continue }
        if (!await this.catalog.withdrawReady(artifact)) { result.protected++; continue }
        result.withdrawn++
        // Retirement is irreversible and independently fences late readers.
        if (await this.disk.collect(artifact.key, artifact.generation, this.catalog)) {
          result.collected++
          result.bytesFreed += artifact.bytes
          this.pendingBytes = Math.max(0, this.pendingBytes - artifact.bytes)
        } else {
          // The pointer is already withdrawn; the sweeper will collect the
          // orphaned generation on a later pass. Do not claim its bytes yet.
          result.protected++
        }
      } catch (error) {
        result.failed++
        result.errors.push(errorCode(error))
      }
    }
    result.pendingBytes = this.pendingBytes
    result.hasMore = result.collected > 0 && candidates.length >= this.batchSize &&
      result.bytesFreed < requestedBytes
    this.totalWithdrawn += result.withdrawn
    this.totalCollected += result.collected
    this.totalBytes += result.bytesFreed
    this.lastResult = result
    try { this.options.onReclaimed?.(result) } catch { /* best effort */ }
    return result
  }
}
