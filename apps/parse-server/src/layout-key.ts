import { createHash } from 'node:crypto'

/**
 * Layout cache key (plan §4.1): layout/measurement results depend on the
 * immutable artifact generation, the renderer/measurement profile and the
 * viewport width — not on the session or user. Clients may cache a laid-out
 * deck under this opaque key and reuse it across sessions.
 */
export const RENDERER_VERSION = 1
export const MEASUREMENT_PROFILE_VERSION = 1

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Stable profile hash for the bundled metric fonts + measurement algorithm. */
export function measurementProfileHash(): string {
  return hash(`measurement-profile:${MEASUREMENT_PROFILE_VERSION}`)
}

export function layoutCacheKey(input: {
  artifactKey: string
  width: number
  fontSetHash: string
  rendererVersion?: number
  measurementProfile?: string
}): string {
  if (!/^[a-f0-9]{64}$/.test(input.artifactKey)) throw new Error('invalid layout artifact key')
  if (!Number.isSafeInteger(input.width) || input.width < 1 || input.width > 100_000)
    throw new Error('invalid layout width')
  if (typeof input.fontSetHash !== 'string' || input.fontSetHash.length === 0 ||
    input.fontSetHash.length > 256)
    throw new Error('invalid layout font set')
  const rendererVersion = input.rendererVersion ?? RENDERER_VERSION
  if (!Number.isSafeInteger(rendererVersion) || rendererVersion < 1)
    throw new Error('invalid renderer version')
  const measurementProfile = input.measurementProfile ?? measurementProfileHash()
  if (!/^[a-f0-9]{64}$/.test(measurementProfile))
    throw new Error('invalid measurement profile')
  return hash(JSON.stringify({
    artifactKey: input.artifactKey,
    rendererVersion,
    width: input.width,
    fontSetHash: input.fontSetHash,
    measurementProfile,
  }))
}
