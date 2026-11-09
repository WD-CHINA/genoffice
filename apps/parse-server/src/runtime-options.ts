import { isAbsolute } from 'node:path'
import type { ParseServerOptions } from './server'

const MAX_TIMER = 2_147_483_647
/** Reject malformed overrides rather than silently restoring a default or disabling a cap. */
export function numberEnv(
  name: string,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw.trim()))
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  const value = Number(raw.trim())
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

export function validateRuntimeOptions(options: ParseServerOptions): void {
  const integer = (name: keyof ParseServerOptions, fallback: number, min: number, max: number) => {
    const value = options[name] ?? fallback
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
      throw new Error(`invalid ${name}: expected integer ${min}..${max}`)
    return value
  }
  integer('port', 0, 0, 65535)
  const heap = integer('workerMemoryMb', 512, 8, 1_048_576)
  const rss = integer('workerRssMb', 4096, 16, 1_048_576)
  const total = integer('parseMemoryMb', 8192, 16, 1_048_576)
  if (heap >= rss || rss > total)
    throw new Error(
      'worker heap must be below worker RSS, and worker RSS must fit the total parse memory budget',
    )
  integer('rssSampleMs', 250, 10, 5000)
  integer('workerLifetimeMs', 600_000, 1, MAX_TIMER)
  integer('parseTimeoutMs', 60_000, 1, MAX_TIMER)
  integer('unitTimeoutMs', 30_000, 1, MAX_TIMER)
  integer('gcIntervalMs', 600_000, 1, MAX_TIMER)
  integer('generationRetainCount', 4, 1, 64)
  integer('readyEvictionIdleMs', 60_000, 0, 2_147_483_647)
  integer('readyEvictionBatchSize', 16, 1, 4096)
  integer('sessionTtlMs', 900_000, 0, Number.MAX_SAFE_INTEGER)
  integer('contentTtlMs', 604_800_000, 0, Number.MAX_SAFE_INTEGER)
  integer('maxStoreBytes', 20 * 1024 ** 3, 0, Number.MAX_SAFE_INTEGER)
  integer('storageReservationLeaseMs', 300_000, 10_000, 3_600_000)
  const high = integer('storageHighWaterPercent', 90, 2, 100)
  const low = integer('storageLowWaterPercent', 80, 1, 99)
  if (low >= high) throw new Error('storage low watermark must be below high watermark')
  integer('maxSessions', 500, 1, 1_000_000)
  integer('maxParseJobs', 2, 1, 256)
  integer('maxQueuedParseJobs', 20, 0, 1_000_000)
  if (
    options.cgroupRoot !== undefined &&
    (!isAbsolute(options.cgroupRoot) || process.platform !== 'linux')
  )
    throw new Error('cgroupRoot must be an absolute Linux cgroup v2 delegation path')
}
