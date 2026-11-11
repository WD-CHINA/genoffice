/**
 * Time-based auto ramp for the v2 canary (plan §10 gray rollout). Operators set
 * a target percentage and a per-hour ramp; the effective percentage starts near
 * zero and increases with process uptime, capped by the target. This is a
 * deterministic traffic ramp, not an observability-driven controller.
 */
export function effectiveRolloutPercent(
  targetPercent: number,
  rampPerHour: number,
  uptimeMs: number,
): number {
  if (!Number.isSafeInteger(targetPercent) || targetPercent < 0 || targetPercent > 100)
    throw new Error('invalid rollout target')
  if (!Number.isSafeInteger(rampPerHour) || rampPerHour < 0 || rampPerHour > 100)
    throw new Error('invalid rollout ramp')
  if (rampPerHour === 0) return targetPercent
  const uptime = Number.isFinite(uptimeMs) && uptimeMs > 0 ? uptimeMs : 0
  const ramped = Math.floor((uptime / 3_600_000) * rampPerHour)
  return Math.min(targetPercent, Math.max(0, ramped))
}

/** Deterministic 0–99 bucket from a canary identity (fileId or tenant id). */
export function rolloutBucket(identity: string): number {
  if (typeof identity !== 'string' || identity.length === 0) return 0
  // FNV-1a keeps this dependency-free; callers that need cryptographic
  // bucketing (tenant ids) hash before passing the value in.
  let hash = 0x811c9dc5
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % 100
}
