/**
 * Per-document reading position (plan §4.1): the durable session preference is
 * the server contract, while the Web viewer remembers the last slide locally so
 * reopening the same file resumes where the reader stopped.
 *
 * Storage is best-effort: private mode / quota errors must never break viewing.
 */
export interface DocxReadingAnchor {
  unitId: string
  blockIndex: number
  offset: number
  row?: number
  paragraph?: number
  sourceOffset?: number
}

export interface ReadingPosition {
  /** Zero-based slide/page index (PPTX). */
  page?: number
  /** DOCX source anchor; survives reflow better than a page number. */
  anchor?: DocxReadingAnchor
  savedAt: number
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KEY = 'genoffice.reading-position.v1'
const TTL_MS = 30 * 24 * 60 * 60_000
const FILE_ID = /^[a-f0-9]{64}$/

function storageOf(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function isDocxAnchor(value: unknown): value is DocxReadingAnchor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const anchor = value as Record<string, unknown>
  if (typeof anchor.unitId !== 'string' || anchor.unitId.length === 0 || anchor.unitId.length > 64)
    return false
  if (!Number.isSafeInteger(anchor.blockIndex) || (anchor.blockIndex as number) < 0) return false
  if (typeof anchor.offset !== 'number' || !Number.isFinite(anchor.offset) || anchor.offset < 0)
    return false
  if (anchor.sourceOffset !== undefined && (typeof anchor.sourceOffset !== 'number' || !Number.isFinite(anchor.sourceOffset) || anchor.sourceOffset < 0)) return false
  for (const key of ['row', 'paragraph'] as const)
    if (anchor[key] !== undefined &&
      (!Number.isSafeInteger(anchor[key]) || (anchor[key] as number) < 0)) return false
  return true
}

function readAll(storage: StorageLike | undefined): Record<string, ReadingPosition> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const entries: Record<string, ReadingPosition> = {}
    const cutoff = Date.now() - TTL_MS
    for (const [fileId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!FILE_ID.test(fileId)) continue
      if (typeof value !== 'object' || value === null) continue
      const position = value as { page?: unknown; anchor?: unknown; savedAt?: unknown }
      if (!Number.isSafeInteger(position.savedAt) ||
        (position.savedAt as number) < cutoff || (position.savedAt as number) > Date.now() + 60_000)
        continue
      const normalized: ReadingPosition = { savedAt: position.savedAt as number }
      if (Number.isSafeInteger(position.page) && (position.page as number) >= 0)
        normalized.page = position.page as number
      if (isDocxAnchor(position.anchor)) normalized.anchor = position.anchor
      if (normalized.page === undefined && normalized.anchor === undefined) continue
      entries[fileId] = normalized
    }
    return entries
  } catch {
    return {}
  }
}

function writeAll(storage: StorageLike | undefined, entries: Record<string, ReadingPosition>): void {
  if (!storage) return
  try {
    storage.setItem(KEY, JSON.stringify(entries))
  } catch {
    /* quota/private mode: reading position is an optimization, never a blocker */
  }
}

export function loadReadingPosition(
  fileId: string | undefined,
  storage?: StorageLike,
): ReadingPosition | undefined {
  if (!fileId || !FILE_ID.test(fileId)) return undefined
  return readAll(storageOf(storage))[fileId]
}

export function saveReadingPosition(
  fileId: string | undefined,
  page: number,
  storage?: StorageLike,
  now: number = Date.now(),
): void {
  if (!fileId || !FILE_ID.test(fileId)) return
  if (!Number.isSafeInteger(page) || page < 0) return
  const current = storageOf(storage)
  const entries = readAll(current)
  entries[fileId] = { page, savedAt: now }
  writeAll(current, entries)
}

/** Persist the DOCX source anchor captured from the current layout. */
export function saveDocxReadingAnchor(
  fileId: string | undefined,
  anchor: DocxReadingAnchor,
  storage?: StorageLike,
  now: number = Date.now(),
): void {
  if (!fileId || !FILE_ID.test(fileId) || !isDocxAnchor(anchor)) return
  const current = storageOf(storage)
  const entries = readAll(current)
  entries[fileId] = { anchor, savedAt: now }
  writeAll(current, entries)
}

/** Server `layoutPrefs` shape for the saved slide, when one exists. */
export function readingLayoutPrefs(
  fileId: string | undefined,
  storage?: StorageLike,
): { page?: number; anchor?: { unitId: string; blockIndex?: number; offsetPx?: number } } | undefined {
  const saved = loadReadingPosition(fileId, storage)
  if (!saved) return undefined
  if (saved.page !== undefined) return { page: saved.page }
  if (!saved.anchor) return undefined
  return {
    anchor: {
      unitId: saved.anchor.unitId,
      blockIndex: saved.anchor.blockIndex,
      offsetPx: saved.anchor.offset,
    },
  }
}

export function clearReadingPosition(fileId: string | undefined, storage?: StorageLike): void {
  if (!fileId || !FILE_ID.test(fileId)) return
  const current = storageOf(storage)
  const entries = readAll(current)
  delete entries[fileId]
  writeAll(current, entries)
}
