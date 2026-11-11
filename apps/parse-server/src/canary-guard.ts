/**
 * Observability-driven canary guard (plan §10/P4): the time ramp is
 * deterministic, this guard is the emergency brake. It watches recent v2
 * session-creation outcomes and pauses the v2 route for a cooldown when the
 * server-error ratio crosses a threshold. Client errors (4xx) are not failures.
 *
 * A paused route answers 404 so existing clients fall back to v1, exactly like
 * the manual canary kill switch.
 */
export interface CanaryGuardOptions {
  /** 0–100; 0 disables the guard. */
  errorRatePercent?: number
  minRequests?: number
  windowMs?: number
  cooldownMs?: number
  now?: () => number
}

export interface CanaryGuardSnapshot {
  enabled: boolean
  paused: boolean
  pausedUntil: number
  samples: number
  failures: number
  errorRatePercent: number
  thresholdPercent: number
  tripped: number
}

export class CanaryGuard {
  private readonly threshold: number
  private readonly minRequests: number
  private readonly windowMs: number
  private readonly cooldownMs: number
  private readonly now: () => number
  private samples: Array<{ at: number; ok: boolean }> = []
  private pausedUntil = 0
  private tripped = 0

  constructor(options: CanaryGuardOptions = {}) {
    const errorRatePercent = options.errorRatePercent ?? 0
    const minRequests = options.minRequests ?? 20
    const windowMs = options.windowMs ?? 60_000
    const cooldownMs = options.cooldownMs ?? 300_000
    if (!Number.isFinite(errorRatePercent) || errorRatePercent < 0 || errorRatePercent > 100)
      throw new Error('invalid canary error rate')
    if (!Number.isSafeInteger(minRequests) || minRequests < 1 || minRequests > 10_000)
      throw new Error('invalid canary min requests')
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000)
      throw new Error('invalid canary window')
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1_000 || cooldownMs > 86_400_000)
      throw new Error('invalid canary cooldown')
    this.threshold = errorRatePercent
    this.minRequests = minRequests
    this.windowMs = windowMs
    this.cooldownMs = cooldownMs
    this.now = options.now ?? Date.now
  }

  /** Record one v2 create outcome; only server errors count as failures. */
  record(ok: boolean): void {
    if (this.threshold === 0) return
    const now = this.now()
    this.samples.push({ at: now, ok })
    if (this.samples.length > 2_000) this.samples.splice(0, this.samples.length - 2_000)
    this.prune(now)
    if (this.samples.length < this.minRequests) return
    const failures = this.samples.filter((sample) => !sample.ok).length
    if ((failures / this.samples.length) * 100 >= this.threshold) {
      this.pausedUntil = Math.max(this.pausedUntil, now + this.cooldownMs)
      this.tripped++
      this.samples = []
    }
  }

  paused(): boolean {
    return this.threshold > 0 && this.now() < this.pausedUntil
  }

  snapshot(): CanaryGuardSnapshot {
    const now = this.now()
    this.prune(now)
    const failures = this.samples.filter((sample) => !sample.ok).length
    return {
      enabled: this.threshold > 0,
      paused: this.paused(),
      pausedUntil: this.pausedUntil,
      samples: this.samples.length,
      failures,
      errorRatePercent: this.samples.length
        ? Math.round((failures / this.samples.length) * 1000) / 10 : 0,
      thresholdPercent: this.threshold,
      tripped: this.tripped,
    }
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    this.samples = this.samples.filter((sample) => sample.at >= cutoff)
  }
}
