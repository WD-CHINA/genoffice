/**
 * Reading-session layout preferences (plan §4.1/§5).
 *
 * A `sessionId` is a temporary reading reference that may carry the reading
 * position/layout preference. This module keeps that DTO explicit and bounded
 * instead of persisting arbitrary client JSON in `parse_sessions`.
 */
export interface LayoutAnchor {
  /** Unit the reader is anchored to (for example `"12"`). */
  unitId: string
  /** Block index inside that unit, when known. */
  blockIndex?: number
  /** Pixel offset inside the anchored block. */
  offsetPx?: number
}

export interface LayoutPrefs {
  /** 0.25 – 4.0; omitted means the deployment default. */
  zoom?: number
  /** Zero-based page/slide index; omitted means "not resumed yet". */
  page?: number
  anchor?: LayoutAnchor
}

const MAX_SERIALIZED_BYTES = 2048
const TOP_KEYS = new Set(['zoom', 'page', 'anchor'])
const ANCHOR_KEYS = new Set(['unitId', 'blockIndex', 'offsetPx'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate and normalize a client-supplied layout preference.
 * Returns undefined when absent; throws `invalid layout preference` otherwise.
 */
export function normalizeLayoutPrefs(value: unknown): LayoutPrefs | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw new Error('invalid layout preference')
  for (const key of Object.keys(value))
    if (!TOP_KEYS.has(key)) throw new Error('invalid layout preference')
  const prefs: LayoutPrefs = {}
  if (value.zoom !== undefined) {
    if (typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) ||
      value.zoom < 0.25 || value.zoom > 4)
      throw new Error('invalid layout preference')
    prefs.zoom = value.zoom
  }
  if (value.page !== undefined) {
    if (!Number.isSafeInteger(value.page) || (value.page as number) < 0 ||
      (value.page as number) > 10_000_000)
      throw new Error('invalid layout preference')
    prefs.page = value.page as number
  }
  if (value.anchor !== undefined) {
    if (!isPlainObject(value.anchor)) throw new Error('invalid layout preference')
    for (const key of Object.keys(value.anchor))
      if (!ANCHOR_KEYS.has(key)) throw new Error('invalid layout preference')
    const { unitId, blockIndex, offsetPx } = value.anchor
    if (typeof unitId !== 'string' || unitId.length === 0 || unitId.length > 64 ||
      unitId.includes('\u0000') || /[\r\n]/.test(unitId))
      throw new Error('invalid layout preference')
    const anchor: LayoutAnchor = { unitId }
    if (blockIndex !== undefined) {
      if (!Number.isSafeInteger(blockIndex) || (blockIndex as number) < 0 || (blockIndex as number) > 1_000_000_000)
        throw new Error('invalid layout preference')
      anchor.blockIndex = blockIndex as number
    }
    if (offsetPx !== undefined) {
      if (typeof offsetPx !== 'number' || !Number.isFinite(offsetPx) ||
        Math.abs(offsetPx) > 1_000_000)
        throw new Error('invalid layout preference')
      anchor.offsetPx = offsetPx
    }
    prefs.anchor = anchor
  }
  if (Buffer.byteLength(JSON.stringify(prefs), 'utf8') > MAX_SERIALIZED_BYTES)
    throw new Error('invalid layout preference')
  return Object.keys(prefs).length > 0 ? prefs : undefined
}
