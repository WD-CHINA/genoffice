import { lstat, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Startup reconcile for immutable generation directories (plan §5/§10):
 * "已落盘但未登记" directories are removed, while anything whose artifact key
 * still has a catalog row is protected (a concurrent claim may be building it,
 * and a ready row must never lose bytes).
 *
 * Only canonical g-N directories inside canonical key/prefix buckets are
 * considered, symlinks/unknown names are skipped, and an age grace avoids racing
 * a publish that is between rename and SQL completion.
 */
export interface GenerationReconcileCatalog {
  /** True when any catalog row (building or ready) exists for this key. */
  hasArtifactRow(key: string): Promise<boolean>
}

export interface GenerationReconcileOptions {
  /** Data directory containing `artifacts/`. */
  root: string
  catalog: GenerationReconcileCatalog
  /** Only directories older than this are removed; defaults to one hour. */
  graceMs?: number
  /** Bounded startup work: stop after inspecting this many key buckets. */
  maxKeys?: number
  now?: () => number
}

export interface GenerationReconcileResult {
  inspectedKeys: number
  removedGenerations: number
  retainedGenerations: number
  removedEmptyKeys: number
  truncated: boolean
  errors: string[]
}

const PREFIX = /^[a-f0-9]{2}$/
const KEY = /^[a-f0-9]{64}$/
const GENERATION = /^g-(?:0|[1-9]\d{0,15})$/

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)
    ? code
    : 'generation_reconcile_failed'
}


export async function reconcileOrphanGenerations(
  options: GenerationReconcileOptions,
): Promise<GenerationReconcileResult> {
  const graceMs = options.graceMs ?? 60 * 60_000
  if (!Number.isSafeInteger(graceMs) || graceMs < 0)
    throw new Error('invalid generation reconcile grace')
  const maxKeys = options.maxKeys ?? 500
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > 100_000)
    throw new Error('invalid generation reconcile bound')
  const now = options.now ?? Date.now
  const artifactsRoot = join(options.root, 'artifacts')
  const result: GenerationReconcileResult = {
    inspectedKeys: 0, removedGenerations: 0, retainedGenerations: 0,
    removedEmptyKeys: 0, truncated: false, errors: [],
  }
  let buckets
  try {
    buckets = await readdir(artifactsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  for (const bucket of buckets.sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.inspectedKeys >= maxKeys) { result.truncated = true; break }
    if (!bucket.isDirectory() || bucket.isSymbolicLink() || !PREFIX.test(bucket.name)) continue
    const bucketPath = join(artifactsRoot, bucket.name)
    let keys
    try {
      keys = await readdir(bucketPath, { withFileTypes: true })
    } catch (error) {
      result.errors.push(errorCode(error))
      continue
    }
    for (const keyEntry of keys.sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.inspectedKeys >= maxKeys) { result.truncated = true; break }
      if (!keyEntry.isDirectory() || keyEntry.isSymbolicLink() || !KEY.test(keyEntry.name)) continue
      result.inspectedKeys++
      const keyPath = join(bucketPath, keyEntry.name)
      let children
      try {
        children = await readdir(keyPath, { withFileTypes: true })
      } catch (error) {
        result.errors.push(errorCode(error))
        continue
      }
      const generations = children.filter(
        (child) => child.isDirectory() && !child.isSymbolicLink() && GENERATION.test(child.name),
      )
      if (generations.length === 0) continue
      let hasRow: boolean
      try {
        hasRow = await options.catalog.hasArtifactRow(keyEntry.name)
      } catch (error) {
        // Fail closed: an unreadable catalog must not be treated as "no row".
        result.errors.push(errorCode(error))
        result.retainedGenerations += generations.length
        continue
      }
      if (hasRow) {
        result.retainedGenerations += generations.length
        continue
      }
      for (const generation of generations) {
        const path = join(keyPath, generation.name)
        let info
        try {
          info = await lstat(path)
        } catch (error) {
          result.errors.push(errorCode(error))
          continue
        }
        if (!info.isDirectory() || info.isSymbolicLink()) continue
        if (now() - info.mtimeMs <= graceMs) {
          result.retainedGenerations++
          continue
        }
        try {
          await rm(path, { recursive: true, force: true })
          result.removedGenerations++
        } catch (error) {
          result.errors.push(errorCode(error))
        }
      }
      // Only remove a key bucket after it became empty through this pass.
      try {
        const remaining = await readdir(keyPath)
        if (remaining.length === 0) {
          await rmdir(keyPath)
          result.removedEmptyKeys++
        }
      } catch {
        /* not empty / concurrently repopulated */
      }
    }
  }
  return result
}