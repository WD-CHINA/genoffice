/**
 * Server capability probe (plan §8.1: match behaviour against
 * `/v2/capabilities` instead of hardcoded assumptions).
 *
 * The probe is best-effort: older servers, reverse proxies and offline servers
 * may not expose the route, and a failed probe must never block opening a
 * document. Only successful, well-formed responses are cached.
 */

import { combineAbortSignals } from './abort-signals'

export interface ServerCapabilities {
  contractVersion?: string
  parserVersion?: string
  formats?: string[]
  maxBytes?: number
  thresholds?: {
    docxAutoRemoteBytes?: number
    pptxAutoRemoteBytes?: number
    docxFullRenderBytes?: number
  }
  features?: Record<string, boolean>
}

export interface FetchCapabilitiesOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  /** Whole-request budget; defaults to 1500 ms. */
  timeoutMs?: number
  signal?: AbortSignal
  /** Cache retention for a successful probe; defaults to 5 minutes. */
  ttlMs?: number
  now?: () => number
}

interface CacheEntry {
  at: number
  value: ServerCapabilities
}

const DEFAULT_TIMEOUT_MS = 1500
const DEFAULT_TTL_MS = 5 * 60_000
const cache = new Map<string, CacheEntry>()

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function parseCapabilities(value: unknown): ServerCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const capabilities: ServerCapabilities = {}
  if (typeof record.contractVersion === 'string') capabilities.contractVersion = record.contractVersion
  if (typeof record.parserVersion === 'string') capabilities.parserVersion = record.parserVersion
  if (Array.isArray(record.formats)) {
    const formats = record.formats.filter((entry): entry is string => typeof entry === 'string')
    if (formats.length > 0) capabilities.formats = formats
  }
  if (typeof record.maxBytes === 'number' && Number.isFinite(record.maxBytes) && record.maxBytes > 0)
    capabilities.maxBytes = record.maxBytes
  if (record.thresholds && typeof record.thresholds === 'object' && !Array.isArray(record.thresholds)) {
    const raw = record.thresholds as Record<string, unknown>
    const thresholds: NonNullable<ServerCapabilities['thresholds']> = {}
    for (const name of ['docxAutoRemoteBytes', 'pptxAutoRemoteBytes', 'docxFullRenderBytes'] as const)
      if (typeof raw[name] === 'number' && Number.isSafeInteger(raw[name]) && raw[name] > 0)
        thresholds[name] = raw[name] as number
    if (Object.keys(thresholds).length > 0) capabilities.thresholds = thresholds
  }
  if (record.features && typeof record.features === 'object' && !Array.isArray(record.features)) {
    const features: Record<string, boolean> = {}
    for (const [name, enabled] of Object.entries(record.features as Record<string, unknown>))
      if (typeof enabled === 'boolean') features[name] = enabled
    capabilities.features = features
  }
  return capabilities
}

/** Successful probes are cached per base URL; failures are not cached. */
export async function fetchCapabilities(
  options: FetchCapabilitiesOptions,
): Promise<ServerCapabilities | undefined> {
  const base = normalizeBase(options.baseUrl)
  if (!/^https?:\/\//.test(base)) return undefined
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const cached = cache.get(base)
  if (cached && now() - cached.at < ttlMs) return cached.value
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const combined = combineAbortSignals(options.signal ? [options.signal, timeout.signal] : [timeout.signal])
  const signal = combined.signal
  try {
    const response = await fetchImpl(base + '/v2/capabilities', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return undefined
    }
    const parsed = parseCapabilities(await response.json())
    if (parsed) cache.set(base, { at: now(), value: parsed })
    return parsed
  } catch {
    return undefined
  } finally {
    combined.dispose()
    clearTimeout(timer)
  }
}

/**
 * Tri-state feature lookup: `undefined` means the server did not declare the
 * capability, so callers keep their legacy behaviour. `false` is an explicit
 * "this server cannot do it" and must disable the feature.
 */
export function featureEnabled(
  capabilities: ServerCapabilities | undefined,
  feature: string,
): boolean | undefined {
  return capabilities?.features?.[feature]
}

/** Conservative helper: only an explicit `true` enables a gated path. */
export function supports(capabilities: ServerCapabilities | undefined, feature: string): boolean {
  return featureEnabled(capabilities, feature) === true
}

export function resetCapabilitiesCacheForTests(): void {
  cache.clear()
}
