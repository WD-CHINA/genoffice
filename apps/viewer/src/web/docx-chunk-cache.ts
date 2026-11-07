/** Byte-weighted LRU for parsed JSON; callers still own their currently rendered values. */
export class DocxChunkCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>()
  private retainedBytes = 0

  constructor(
    readonly maxBytes = 8 * 1024 * 1024,
    readonly maxEntries = 128,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 ||
        !Number.isSafeInteger(maxEntries) || maxEntries < 0)
      throw new Error('Invalid DOCX cache budget')
  }

  get bytes(): number { return this.retainedBytes }
  get size(): number { return this.entries.size }

  get(id: string): T | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined
    this.entries.delete(id)
    this.entries.set(id, entry)
    return entry.value
  }

  set(id: string, value: T): void {
    // UTF-16 serialized size is a predictable retention weight, not a JS heap measurement.
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error('Invalid DOCX chunk')
    const bytes = serialized.length * 2
    const old = this.entries.get(id)
    if (old) {
      this.entries.delete(id)
      this.retainedBytes -= old.bytes
    }
    // An oversized unit may be rendered by its caller but never lives in this cache.
    if (bytes > this.maxBytes || this.maxEntries === 0) return
    while (this.entries.size >= this.maxEntries || this.retainedBytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value!
      const entry = this.entries.get(oldest)!
      this.entries.delete(oldest)
      this.retainedBytes -= entry.bytes
    }
    this.entries.set(id, { value, bytes })
    this.retainedBytes += bytes
  }

  clear(): void {
    this.entries.clear()
    this.retainedBytes = 0
  }
}
