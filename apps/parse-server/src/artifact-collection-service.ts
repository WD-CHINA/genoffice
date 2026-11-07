import type { ArtifactGenerationSweeper, GenerationSweepResult } from './artifact-generation-sweeper'

interface Options {
  intervalMs?: number
  continuationMs?: number
  batchSize?: number
  graceMs?: number
  errorBackoffMs?: number
}

/** Owns scheduling, coalescing and shutdown; it does not bypass the sweeper's retirement checks. */
export class ArtifactCollectionService {
  private readonly options: Required<Options>
  private timer?: ReturnType<typeof setTimeout>
  private active?: Promise<void>
  private closing?: Promise<void>
  private stopped = false
  private started = false
  private requested = false
  private urgentRequested = false
  private urgentPasses = 0
  private passes = 0
  private lastResult?: GenerationSweepResult
  private lastErrorCode?: string
  private retryAfter = 0

  constructor(private readonly sweeper: Pick<ArtifactGenerationSweeper, 'sweep' | 'close'>,
    options: Options = {}) {
    this.options = { intervalMs: options.intervalMs ?? 10 * 60_000,
      continuationMs: options.continuationMs ?? 25, batchSize: options.batchSize ?? 64,
      graceMs: options.graceMs ?? 60 * 60_000, errorBackoffMs: options.errorBackoffMs ?? 1000 }
    for (const value of [this.options.intervalMs, this.options.continuationMs, this.options.errorBackoffMs])
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error('invalid generation collection interval')
    if (!Number.isSafeInteger(this.options.batchSize) || this.options.batchSize < 1 || this.options.batchSize > 4096 ||
        !Number.isSafeInteger(this.options.graceMs) || this.options.graceMs < 0)
      throw new Error('invalid generation collection options')
  }

  get snapshot() {
    return { running: !!this.active, stopped: this.stopped, passes: this.passes,
      urgentPasses: this.urgentPasses, lastResult: this.lastResult,
      lastErrorCode: this.lastErrorCode }
  }

  start(): void {
    if (this.stopped) throw new Error('generation collection service closed')
    if (this.started) return
    this.started = true
    this.schedule(0)
  }

  /** `urgent` is a storage high-water hint: old generations skip their grace period. */
  request(urgent = false): void {
    if (this.stopped) throw new Error('generation collection service closed')
    this.started = true
    if (urgent) this.urgentRequested = true
    if (this.active) this.requested = true
    else this.schedule(0)
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run(), Math.max(ms, this.retryAfter - performance.now()))
    this.timer.unref()
  }

  private run(): void {
    if (this.stopped || this.active) return
    this.timer = undefined
    let next = this.options.intervalMs
    const urgent = this.urgentRequested
    this.urgentRequested = false
    const work = Promise.resolve().then(async () => {
      if (this.stopped) return
      try {
        const result = await this.sweeper.sweep(this.options.batchSize, this.options.graceMs, { urgent })
        this.lastResult = result
        this.lastErrorCode = undefined
        this.passes++
        if (urgent) this.urgentPasses++
        this.retryAfter = result.failed ? performance.now() + this.options.errorBackoffMs : 0
        if (result.hasMore && !result.stopped) next = this.options.continuationMs
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        this.retryAfter = performance.now() + this.options.errorBackoffMs
        this.lastErrorCode = typeof code === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(code)
          ? code : 'generation_sweep_failed'
      }
    })
    this.active = work
    void work.finally(() => {
      if (this.active === work) this.active = undefined
      if (this.stopped) return
      this.schedule(this.requested ? 0 : next)
      this.requested = false
    }).catch(() => undefined)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    clearTimeout(this.timer)
    this.closing = Promise.allSettled([this.sweeper.close(), this.active]).then(() => undefined)
    return this.closing
  }
}
