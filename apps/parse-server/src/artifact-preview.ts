import { canonicalJson } from './artifact-store'

/**
 * Incremental first-frame preview state.
 *
 * These snapshots live only in the build owner's process and are never written to
 * the shared catalog, the generation directory or a durable session journal. A
 * unit is published here *only after* `ArtifactWriter.append` has committed its
 * gzip+sha256 frame, so every previewed record is byte-identical to the record
 * that will be published in the final generation. Nothing in this module can
 * mark an artifact ready, mutate an already published unit, or authorise an
 * offline bundle: `complete: false` is always reported until the full manifest
 * exists and the v1 session itself transitions to `ready`.
 */

export interface PreviewDocument {
  model: {
    format: string
    unitCount?: number
    unitKind?: string
    [key: string]: unknown
  }
  fonts: unknown[]
  layout?: unknown
}

export type BuildPreviewEvent =
  | {
      type: 'document'
      format: 'pptx' | 'docx'
      unitCount: number
      /** Canonical (unsigned, origin-free) document record shared with the writer. */
      document: unknown
      /** DOCX style context is a separate record, not part of `document`. */
      styles?: unknown
    }
  | { type: 'unit'; index: number; unit: unknown; unitsProduced: number }
  | { type: 'done' }
  | { type: 'failed' }

export interface PreviewSnapshot {
  readonly key: string
  readonly format: 'pptx' | 'docx'
  readonly document: PreviewDocument
  readonly styles?: unknown
  readonly unitCount: number
  /** Number of frames already committed to the writer (monotonic). */
  readonly unitsProduced: number
  /** Units retained in memory, as the half-open range [0, cachedUntil). */
  readonly cachedUntil: number
  readonly units: readonly unknown[]
  /** All frames were written; still not ready until the manifest is published. */
  readonly complete: boolean
  readonly previewable: boolean
  readonly updatedAt: number
}

/**
 * Read-only, non-copying view of a retained build. The hot-cache mirror uses it
 * to decide whether the local registry actually accepted a frame without paying
 * for the defensive deep copy that `get()` performs.
 */
export interface PreviewMirrorState {
  readonly format: 'pptx' | 'docx'
  readonly unitCount: number
  readonly unitsProduced: number
  /** Number of units retained locally, as the half-open range [0, cachedUntil). */
  readonly cachedUntil: number
  /** The build finished writing every frame; still not ready until the manifest is published. */
  readonly complete: boolean
  readonly updatedAt: number
}

interface PreviewState {
  key: string
  format: 'pptx' | 'docx'
  document: PreviewDocument
  styles?: unknown
  unitCount: number
  unitsProduced: number
  units: unknown[]
  bytes: number
  complete: boolean
  updatedAt: number
}

export interface PreviewRegistryOptions {
  /** Maximum retained units per build (the first frame plus a small window). */
  maxUnits?: number
  /** Maximum canonical JSON bytes retained per build. */
  maxBytes?: number
  /** Maximum concurrent/remembered builds. */
  maxKeys?: number
  /** Retention after the last update; failures are dropped immediately. */
  ttlMs?: number
  now?: () => number
}

const DEFAULTS = {
  maxUnits: 8,
  maxBytes: 2 * 1024 * 1024,
  maxKeys: 16,
  ttlMs: 60_000,
}

/**
 * Strict validator for a preview document record. Exported so the hot-cache
 * reader applies exactly the same rules as the in-process registry.
 */
export function parsePreviewDocument(value: unknown): PreviewDocument | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const rawModel = record.model
  if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) return null
  const model = rawModel as Record<string, unknown>
  if (typeof model.format !== 'string' || !['pptx', 'docx'].includes(model.format)) return null
  if (
    model.unitCount !== undefined &&
    (!Number.isSafeInteger(model.unitCount) || (model.unitCount as number) < 0)
  )
    return null
  if (!Array.isArray(record.fonts)) return null
  return { model: model as PreviewDocument['model'], fonts: record.fonts, layout: record.layout }
}

/** In-process, bounded registry of build-time preview snapshots. Never throws into a build. */
export class PreviewRegistry {
  private readonly states = new Map<string, PreviewState>()
  private readonly maxUnits: number
  private readonly maxBytes: number
  private readonly maxKeys: number
  private readonly ttlMs: number
  private readonly now: () => number
  private dropped = 0
  private failed = 0
  private completed = 0

  constructor(options: PreviewRegistryOptions = {}) {
    this.maxUnits = options.maxUnits ?? DEFAULTS.maxUnits
    this.maxBytes = options.maxBytes ?? DEFAULTS.maxBytes
    this.maxKeys = options.maxKeys ?? DEFAULTS.maxKeys
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs
    this.now = options.now ?? Date.now
    for (const [name, value] of Object.entries({
      maxUnits: this.maxUnits,
      maxBytes: this.maxBytes,
      maxKeys: this.maxKeys,
      ttlMs: this.ttlMs,
    })) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
        throw new Error(`invalid preview ${name}`)
    }
  }

  report(key: string, event: BuildPreviewEvent): void {
    try {
      if (typeof key !== 'string' || !key) return
      if (event.type === 'failed') {
        this.states.delete(key)
        this.failed++
        return
      }
      if (event.type === 'done') {
        const state = this.states.get(key)
        if (state) {
          state.complete = true
          state.updatedAt = this.now()
          this.completed++
        }
        return
      }
      if (event.type === 'document') {
        const document = parsePreviewDocument(event.document)
        const unitCount = event.unitCount
        if (!document || !Number.isSafeInteger(unitCount) || unitCount < 0 || unitCount > 100_000) {
          this.dropped++
          return
        }
        this.states.set(key, {
          key,
          format: event.format,
          document,
          ...(event.styles !== undefined ? { styles: event.styles } : {}),
          unitCount,
          unitsProduced: 0,
          units: [],
          bytes: 0,
          complete: false,
          updatedAt: this.now(),
        })
        this.prune()
        return
      }
      const state = this.states.get(key)
      if (!state || state.complete) return
      // Only strictly consecutive, already-committed frames may advance the range.
      if (
        event.index !== state.unitsProduced ||
        event.unitsProduced !== event.index + 1 ||
        event.index >= state.unitCount
      ) {
        this.dropped++
        return
      }
      state.unitsProduced = event.unitsProduced
      if (state.units.length === event.index && state.units.length < this.maxUnits) {
        let size: number
        try {
          size = Buffer.byteLength(canonicalJson(event.unit as never))
        } catch {
          size = this.maxBytes + 1
        }
        if (state.bytes + size <= this.maxBytes) {
          state.units.push(event.unit)
          state.bytes += size
        }
      }
      state.updatedAt = this.now()
    } catch {
      // Progress reporting is observational: a malformed event must never fail a build.
      this.dropped++
    }
  }

  /** Read-only view without deep-copying retained units. Never hand this to consumers. */
  peek(key: string): PreviewMirrorState | undefined {
    this.prune()
    const state = this.states.get(key)
    if (!state) return undefined
    return {
      format: state.format,
      unitCount: state.unitCount,
      unitsProduced: state.unitsProduced,
      cachedUntil: state.units.length,
      complete: state.complete,
      updatedAt: state.updatedAt,
    }
  }

  get(key: string): PreviewSnapshot | undefined {
    this.prune()
    const state = this.states.get(key)
    if (!state) return undefined
    return {
      key: state.key,
      format: state.format,
      document: state.document,
      ...(state.styles !== undefined ? { styles: state.styles } : {}),
      unitCount: state.unitCount,
      unitsProduced: state.unitsProduced,
      cachedUntil: state.units.length,
      // Deep copy: a consumer must not be able to mutate a committed record,
      // even though it only ever serialises the snapshot into a response.
      units: state.units.map((entry) => {
        try {
          return structuredClone(entry)
        } catch {
          return entry
        }
      }),
      complete: state.complete,
      previewable: state.unitsProduced > 0 && state.units.length > 0,
      updatedAt: state.updatedAt,
    }
  }

  stats(): {
    keys: number
    cachedUnits: number
    cachedBytes: number
    completed: number
    failed: number
    dropped: number
  } {
    this.prune()
    let cachedUnits = 0
    let cachedBytes = 0
    for (const state of this.states.values()) {
      cachedUnits += state.units.length
      cachedBytes += state.bytes
    }
    return {
      keys: this.states.size,
      cachedUnits,
      cachedBytes,
      completed: this.completed,
      failed: this.failed,
      dropped: this.dropped,
    }
  }

  clear(): void {
    this.states.clear()
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [key, state] of this.states) if (state.updatedAt < cutoff) this.states.delete(key)
    while (this.states.size > this.maxKeys) {
      let oldestKey: string | undefined
      let oldest = Infinity
      for (const [key, state] of this.states)
        if (state.updatedAt < oldest) {
          oldest = state.updatedAt
          oldestKey = key
        }
      if (!oldestKey) break
      this.states.delete(oldestKey)
    }
  }
}
