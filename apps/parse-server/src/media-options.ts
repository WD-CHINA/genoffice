import { numberEnv } from './runtime-options'

export interface MediaOptions {
  enabled?: boolean
  ffmpeg?: string
  ffprobe?: string
  concurrency?: number
  maxQueued?: number
  maxInputBytes?: number
  maxOutputBytes?: number
  maxCacheBytes?: number
  maxCacheEntries?: number
  timeoutMs?: number
  workerRssMb?: number
  cacheTtlMs?: number
  leaseMs?: number
}
export const MEDIA_DEFAULTS = {
  ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', concurrency: 1, maxQueued: 64,
  maxInputBytes: 512 * 1024 ** 2, maxOutputBytes: 1024 ** 3,
  maxCacheBytes: 10 * 1024 ** 3, timeoutMs: 20 * 60_000,
  maxCacheEntries: 10_000,
  workerRssMb: 1024, cacheTtlMs: 7 * 24 * 60 * 60_000, leaseMs: 30_000,
}
export function resolveMediaOptions(value: MediaOptions = {}) {
  const result = { ...MEDIA_DEFAULTS, ...value, enabled: value.enabled ?? false }
  if (typeof result.enabled !== 'boolean') throw new Error('invalid media enabled flag')
  for (const key of ['ffmpeg', 'ffprobe'] as const)
    if (typeof result[key] !== 'string' || !result[key].trim()) throw new Error(`invalid media ${key}`)
  for (const key of Object.keys(MEDIA_DEFAULTS).filter((key) => !['ffmpeg', 'ffprobe'].includes(key))) {
    const number = result[key as keyof typeof MEDIA_DEFAULTS]
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1)
      throw new Error(`invalid media ${key}`)
  }
  if (result.concurrency > 16 || result.maxQueued > 10000 || result.leaseMs < 3000 ||
      result.leaseMs > 600_000 || result.timeoutMs > 2_147_483_647 ||
      result.cacheTtlMs > 2_147_483_647 || result.maxInputBytes > 2 * 1024 ** 3 ||
      result.maxOutputBytes > 4 * 1024 ** 3 ||
      result.maxCacheEntries > 100_000 ||
      result.maxCacheBytes < result.maxInputBytes + result.maxOutputBytes)
    throw new Error('invalid media limits')
  return result
}
export function mediaOptionsFromEnv(): MediaOptions {
  const enabled = process.env.PARSE_SERVER_MEDIA_ENABLED?.trim().toLowerCase()
  if (enabled !== undefined && !['true', 'false', '1', '0'].includes(enabled))
    throw new Error('PARSE_SERVER_MEDIA_ENABLED must be true/false/1/0')
  return {
    enabled: enabled === 'true' || enabled === '1',
    ...(process.env.PARSE_SERVER_FFMPEG ? { ffmpeg: process.env.PARSE_SERVER_FFMPEG } : {}),
    ...(process.env.PARSE_SERVER_FFPROBE ? { ffprobe: process.env.PARSE_SERVER_FFPROBE } : {}),
    ...Object.fromEntries([
      ['concurrency', 'CONCURRENCY'], ['maxQueued', 'MAX_QUEUED'], ['timeoutMs', 'TIMEOUT_MS'],
      ['maxInputBytes', 'MAX_INPUT_BYTES'], ['maxOutputBytes', 'MAX_OUTPUT_BYTES'],
      ['maxCacheBytes', 'MAX_CACHE_BYTES'], ['workerRssMb', 'WORKER_RSS_MB'], ['cacheTtlMs', 'CACHE_TTL_MS'],
      ['maxCacheEntries', 'MAX_CACHE_ENTRIES'],
    ].flatMap(([key, env]) => {
      const value = numberEnv('PARSE_SERVER_MEDIA_' + env)
      return value === undefined ? [] : [[key, value]]
    })),
  }
}
