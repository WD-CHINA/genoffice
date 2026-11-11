/**
 * Signed media URL inspection.
 *
 * Parse-server responses embed absolute part URLs with `exp`/`sig` query
 * parameters (plan §7: a session can refresh the resource description when a
 * signature expires, without invalidating the model cache). The viewer caches
 * unit/chunk JSON, so a cached description can outlive its signature; this
 * helper detects that case before the browser reports a 403 for an image.
 */

export interface SignedResourceState {
  signed: boolean
  /** Unix seconds when present and numeric. */
  exp?: number
  expired: boolean
  /** Absolute origin when the value was an absolute URL. */
  origin?: string
}

const PART_MARKER = '/v1/files/'
/** Refresh slightly before the exact expiry to avoid a race at the boundary. */
const DEFAULT_SKEW_SECONDS = 60

function lookup(value: string): URL | undefined {
  try {
    return new URL(value, 'http://viewer.invalid/')
  } catch {
    return undefined
  }
}

/** Inspect one string; unsigned / non-resource strings report `signed: false`. */
export function inspectSignedResource(
  value: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
  skewSeconds = DEFAULT_SKEW_SECONDS,
): SignedResourceState {
  if (typeof value !== 'string' || !value.includes(PART_MARKER))
    return { signed: false, expired: false }
  const parsed = lookup(value)
  if (!parsed) return { signed: false, expired: false }
  const sig = parsed.searchParams.get('sig')
  const expText = parsed.searchParams.get('exp')
  if (sig === null && expText === null) return { signed: false, expired: false }
  const exp = expText !== null && /^\d+$/.test(expText) ? Number(expText) : undefined
  const expired = exp === undefined || exp <= nowSeconds + Math.max(0, skewSeconds)
  return {
    signed: true,
    ...(exp !== undefined ? { exp } : {}),
    expired,
    ...(/^https?:\/\//.test(value) ? { origin: parsed.origin } : {}),
  }
}

export interface ResourceRefreshOptions {
  nowSeconds?: number
  skewSeconds?: number
  /** Current API origin; absolute URLs pointing elsewhere are stale (deploy move). */
  baseOrigin?: string
}

function isStale(value: unknown, options: ResourceRefreshOptions): boolean {
  const state = inspectSignedResource(value, options.nowSeconds, options.skewSeconds)
  if (!state.signed) return false
  if (state.expired) return true
  if (options.baseOrigin && state.origin && state.origin !== options.baseOrigin) return true
  return false
}

/**
 * True when any string inside a unit/description needs a fresh signed URL.
 * Values are server JSON, but depth is bounded anyway to stay safe on bad data.
 */
export function needsResourceRefresh(
  value: unknown,
  options: ResourceRefreshOptions = {},
  depth = 0,
): boolean {
  if (depth > 32) return false
  if (typeof value === 'string') return isStale(value, options)
  if (Array.isArray(value)) return value.some((item) => needsResourceRefresh(item, options, depth + 1))
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some((item) =>
      needsResourceRefresh(item, options, depth + 1),
    )
  return false
}

/** Extract the API origin from a session base URL, if it is absolute. */
export function originOf(baseUrl: string): string | undefined {
  const parsed = lookup(baseUrl)
  return parsed && /^https?:\/\//.test(baseUrl) ? parsed.origin : undefined
}
