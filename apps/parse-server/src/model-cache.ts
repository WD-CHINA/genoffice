import type { JsonValue } from './artifact-store'

/** Plan §6.1: initial in-memory model hot-cache budget. */
export const MODEL_CACHE_DEFAULT_BYTES = 256 * 1024 * 1024
/** Plan §6.1: target budget for HTTP/index/read caches; model cache is carved out of it. */
export const MEMORY_CACHE_BUDGET_DEFAULT_BYTES = 2 * 1024 * 1024 * 1024

export interface ModelCacheStats {
  maxBytes: number
  bytes: number
  entries: number
  hits: number
  misses: number
  evictions: number
  skipped: number
}

interface Entry<T> {
  value: T
  bytes: number
}

/**
 * Byte-bounded LRU for immutable artifact records (document/unit/layout/styles).
 * Plan §6.1 requires byte accounting, not an entry count: a handful of large
 * layout pages must evict before the process crosses its read-cache budget.
 *
 * Keys are namespaced by generation content digest by the reader, so a repaired
 * generation can never be served a stale record from the same artifact key.
 */
export class ModelCache<T = JsonValue | Buffer> {
  private readonly entries = new Map<string, Entry<T>>()
  private bytes = 0
  private hits = 0
  private misses = 0
  private evictions = 0
  private skipped = 0

  constructor(readonly maxBytes: number = MODEL_CACHE_DEFAULT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('invalid model cache budget')
  }

  get enabled(): boolean {
    return this.maxBytes > 0
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined
    const entry = this.entries.get(key)
    if (!entry) {
      this.misses++
      return undefined
    }
    // Refresh recency: Map iteration order is the eviction order.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return entry.value
  }

  set(key: string, value: T, bytes: number): void {
    if (!this.enabled) return
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid model cache entry size')
    if (bytes > this.maxBytes) {
      this.skipped++
      return
    }
    const previous = this.entries.get(key)
    if (previous) {
      this.bytes -= previous.bytes
      this.entries.delete(key)
    }
    this.entries.set(key, { value, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      const evicted = this.entries.get(oldest)!
      this.entries.delete(oldest)
      this.bytes -= evicted.bytes
      this.evictions++
    }
  }

  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }

  stats(): ModelCacheStats {
    return {
      maxBytes: this.maxBytes,
      bytes: this.bytes,
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      skipped: this.skipped,
    }
  }
}

/** Byte size of a cacheable record as it is held in memory. */
export function recordBytes(value: JsonValue | Buffer): number {
  if (Buffer.isBuffer(value)) return value.byteLength
  return Buffer.byteLength(JSON.stringify(value))
}
