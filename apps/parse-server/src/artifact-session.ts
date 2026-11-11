import { join } from 'node:path'
import type { MysqlArtifactCatalog } from './artifact-catalog'
import type { ArtifactGenerations } from './artifact-generations'
import type { ArtifactCoordinator } from './artifact-coordinator'
import { randomUUID } from 'node:crypto'
import { ArtifactReadHandle } from './artifact-read-handle'
import { writeOfflineBundle, writeDocxOfflineBundle, externalMedia, validBundlePath } from './offline-bundle'
import { exportArtifactDirectory, type ArtifactExportResult } from './artifact-export'
import type { OfflineBundleManifest, OfflineBundleResource } from '@genoffice/parse-contract'
import type { WidthItem } from './metrics'
import type { ParseQueue } from './parse-queue'
import type { DocModel } from '@genoffice/parse-contract'
import {
  ArtifactStore,
  ArtifactCorruptionError,
  artifactKey,
  canonicalJson,
  normalizeArtifactOptions,
  type ArtifactReader,
  type ArtifactWriter,
  type ArtifactIdentity,
  type JsonValue,
} from './artifact-store'
import { PptxSession, type PptxOpenInput } from './pptx'
import { DocxSession } from './docx-session'
import type { PptxFontSummary, PptxLayoutInfo, PptxLayoutSlide } from './pptx-core'
import { refreshDocxResourceUrls } from './resource-urls'
import { chunkDir, removeChunks } from './docx-chunks'
import type { BuildPreviewEvent } from './artifact-preview'

export const MODEL_SCHEMA_VERSION = 2

/** Records physically owned by an offline-bundle artifact; the rest come from the model. */
function bundleDerivedId(path: string): string | null {
  if (path === 'layout.json') return 'bundle:layout'
  if (path.startsWith('parts/')) return `bundle:part:${path.slice(6)}`
  return null
}

function isDerivedRecord(id: string): boolean {
  return id === 'bundle:layout' || id.startsWith('bundle:part:')
}

/** A legacy flat bundle may only be trusted if its authoritative manifest is intact. */
function isLegacyBundleManifest(
  value: unknown,
  identity: ArtifactIdentity,
  key: string,
): value is OfflineBundleManifest {
  const manifest = value as Partial<OfflineBundleManifest> | null
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const options = identity.options as { purpose?: unknown; modelArtifactKey?: unknown } | null
  if (
    manifest.bundleSchemaVersion !== 1 ||
    manifest.modelSchemaVersion !== MODEL_SCHEMA_VERSION ||
    manifest.artifactKey !== key ||
    manifest.modelArtifactKey !== options?.modelArtifactKey ||
    options?.purpose !== 'offline-bundle' ||
    manifest.fileId !== identity.fileId ||
    manifest.format !== 'pptx' ||
    manifest.inventory !== 'ppt-media-v1' ||
    !Number.isSafeInteger(manifest.unitCount) || (manifest.unitCount ?? -1) < 0 ||
    !Array.isArray(manifest.fonts) ||
    !Array.isArray(manifest.externalResources) ||
    !Array.isArray(manifest.resources) || !manifest.resources.length ||
    !Number.isSafeInteger(manifest.totalBytes)
  ) return false
  let total = 0
  let layouts = 0
  let pages = 0
  let fonts = 0
  for (const resource of manifest.resources) {
    if (!resource || typeof resource !== 'object') return false
    if (
      typeof resource.path !== 'string' || !validBundlePath(resource.path) ||
      !Number.isSafeInteger(resource.size) || resource.size < 0 ||
      typeof resource.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(resource.sha256)
    ) return false
    total += resource.size
    if (resource.path === 'layout.json') layouts++
    else if (/^layout\/(0|[1-9]\d*)\.json$/.test(resource.path)) pages++
    else if (/^fonts\/font-(0|[1-9]\d*)\.sfnt$/.test(resource.path)) fonts++
    else if (!resource.path.startsWith('parts/')) return false
  }
  // The inventory must fully describe the layout, every page and every font.
  return total === manifest.totalBytes && layouts === 1 &&
    pages === manifest.unitCount && fonts === manifest.fonts.length
}

/** Explicit wire conversion: optional object fields are omitted; runtime objects are rejected. */
export function modelDto(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value))
    return Array.from(value, (item) => (item === undefined ? null : modelDto(item)))
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, modelDto(item)]),
    )
  }
  throw new Error('unsupported runtime value in document model DTO')
}

/** Store internal resource paths without origin or expiring authentication data. */
export function canonicalResources(value: JsonValue, fileId: string): JsonValue {
  if (Array.isArray(value)) return value.map((item) => canonicalResources(item, fileId))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, canonicalResources(child, fileId)]),
    )
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value, 'http://artifact.invalid')
    if (url.pathname.startsWith(`/v1/files/${fileId}/parts/`)) return url.pathname
  } catch {
    /* ordinary model strings are not URLs */
  }
  return value
}

export interface StoredDocument {
  model: DocModel
  fonts: PptxFontSummary[]
  layout?: PptxLayoutInfo
}

/** Rebuild the shared artifact and return a fresh, already-validated view pin. */
export type ArtifactRepair = () => Promise<{
  handle: ArtifactReadHandle
  document: StoredDocument
}>

/** Cross-process artifact backend. The offline bundle is a derived generation on the same catalog. */
export interface SharedArtifactBackend {
  catalog: MysqlArtifactCatalog
  disk: ArtifactGenerations
  coordinator: ArtifactCoordinator
}

type BundleReader = ArtifactReader | ArtifactReadHandle

export interface ArtifactSessionInput extends PptxOpenInput {
  format: 'pptx' | 'docx'
  parserFingerprint: string
  chunkRoot: string
}

/** One lightweight reader per viewing session; parsing is shared by artifact identity. */
export class ArtifactSession {
  get model(): DocModel {
    const model = this.document.model
    // Only resource descriptions are session-specific. Large note/section
    // collections keep sharing their immutable artifact-cache objects.
    if (!model.docx) return model
    return { ...model, docx: { ...model.docx,
      hfParts: refreshDocxResourceUrls(model.docx.hfParts, this.input.fileId, this.input.baseUrl, this.input.mediaSecret) as Record<string, object>,
    } }
  }
  fonts: PptxFontSummary[]
  private readonly widths: Record<string, number> = {}
  private readonly pendingWidths = new Map<string, WidthItem>()
  private readonly renderers = new Set<PptxSession>()
  private readonly renderFlights = new Set<Promise<unknown>>()
  private closed = false
  private bundleOpening?: Promise<BundleReader>
  /** Derived bundle generations own their own read leases until the view closes. */
  private readonly bundlePins: ArtifactReadHandle[] = []
  private bundleRepairs = 0
  private repairing?: Promise<void>
  private repairs = 0
  /** Old generation pins stay alive until the view closes, so in-flight reads are never aborted. */
  private readonly retired: ArtifactReadHandle[] = []

  private constructor(
    private reader: ArtifactReader | ArtifactReadHandle,
    private document: StoredDocument,
    private readonly store: ArtifactStore,
    private readonly input: ArtifactSessionInput,
    private readonly queue?: ParseQueue,
    private readonly repair?: ArtifactRepair,
    private readonly shared?: SharedArtifactBackend,
  ) {
    this.fonts = document.fonts
  }

  static identity(
    input: Pick<ArtifactSessionInput, 'fileId' | 'format' | 'parserVersion' | 'parserFingerprint'>,
  ): ArtifactIdentity {
    return {
      fileId: input.fileId,
      format: input.format,
      parserFingerprint: `${input.parserVersion}:${input.parserFingerprint}`,
      schemaVersion: MODEL_SCHEMA_VERSION,
      options: normalizeArtifactOptions(),
    }
  }

  /**
   * Canonical sidecar layout (plan §4.2, staged/opt-in): materialize
   * document.json/units/fonts next to the packed units.bin of this generation.
   * The packed format remains the runtime truth; this is for inspection,
   * portability and backup tooling.
   */
  canonicalDirectory(dataDir: string): string {
    return this.reader instanceof ArtifactReadHandle
      ? join(dataDir, this.reader.artifact.storagePath)
      : this.reader.directory
  }

  async materializeCanonical(
    dataDir: string,
    reserve?: (bytes: number) => Promise<void>,
  ): Promise<ArtifactExportResult> {
    return await exportArtifactDirectory(this.reader, this.canonicalDirectory(dataDir), { reserve })
  }

  /** Shared source build used by both storage backends; signal belongs to the build, never a viewer. */
  static async build(store: ArtifactStore, input: ArtifactSessionInput, writer: ArtifactWriter,
    queue?: ParseQueue, signal?: AbortSignal, onAdmission?: () => void,
    jobId?: string): Promise<void> {
    const key = artifactKey(this.identity(input))
    const notify = (event: BuildPreviewEvent): void => {
      // Observation only: a broken observer must never fail a build or a lease.
      // The observer lives on the parent-process store, never on the cloned input.
      // `jobId` (catalog build lease) binds preview/projection keys to one attempt.
      try { store.previewObserver?.(key, event, jobId) } catch { /* ignore */ }
    }
    const build = async () => {
      try {
        signal?.throwIfAborted()
        store.markRunning(artifactKey(this.identity(input)))
        // Canonical origin and no signing secret: deployment URLs never enter the shared artifact.
        const canonicalInput = {
          ...input,
          signal,
          baseUrl: 'http://artifact.invalid',
          mediaSecret: undefined,
        }
        const chunksDir = chunkDir(input.chunkRoot, input.id)
        store.stats.sourceParsesStarted++
        let parser: PptxSession | DocxSession | undefined
        let metadata: { unitCount: number; fonts: string[]; warnings: string[] } | undefined
        const scratch = input.format === 'docx' ? store.scratchReservation() : undefined
        try {
          await removeChunks(chunksDir)
          signal?.throwIfAborted()
          parser =
            input.format === 'pptx'
              ? await PptxSession.open(canonicalInput)
              : await DocxSession.open({
                  ...canonicalInput,
                  chunksDir,
                  reserveStorage: scratch?.reserve,
                })
          signal?.throwIfAborted()
          const document: StoredDocument = { model: parser.model, fonts: parser.fonts }
          let styles: JsonValue | undefined
          if (parser instanceof PptxSession) document.layout = await parser.layoutInfo()
          else {
            styles = modelDto(await parser.styleContext())
            await writer.append('styles', styles)
          }
          // Publish the exact canonical bytes to the observer as well: a preview
          // record is never a separate, possibly divergent rendering of a unit.
          const canonicalDocument = canonicalResources(modelDto(document), input.fileId)
          await writer.append('document', canonicalDocument)
          notify({
            type: 'document',
            format: input.format,
            unitCount: parser.model.unitCount ?? 0,
            document: canonicalDocument,
            ...(styles !== undefined ? { styles } : {}),
          })
          const external = new Set<string>()
          for (let index = 0; index < (parser.model.unitCount ?? 0); index++) {
            signal?.throwIfAborted()
            const unit =
              parser instanceof PptxSession
                ? await parser.layoutModel(String(index))
                : await parser.unit(String(index))
            signal?.throwIfAborted()
            const canonicalUnit = canonicalResources(modelDto(unit), input.fileId)
            await writer.append(`unit:${index}`, canonicalUnit)
            notify({ type: 'unit', index, unit: canonicalUnit, unitsProduced: index + 1 })
            if (input.format === 'pptx')
              for (const url of externalMedia(unit as PptxLayoutSlide)) external.add(url)
          }
          for (const font of parser.fonts) {
            signal?.throwIfAborted()
            const bytes = await parser.fontBytes(font.id)
            if (!bytes) throw new Error(`missing embedded font: ${font.id}`)
            await writer.append(`font:${font.id}`, bytes)
          }
          signal?.throwIfAborted()
          if (input.format === 'pptx') await writer.append('external-media', [...external].sort())
          metadata = {
            unitCount: parser.model.unitCount ?? 0,
            fonts: parser.fonts.map((font) => font.id),
            warnings: (parser.model.warnings ?? []).map((warning) =>
              String((warning as { message?: unknown }).message ?? warning)),
          }
        } finally {
          try {
            await parser?.dispose()
            await removeChunks(chunksDir)
          } finally {
            await scratch?.release()
          }
        }
        if (metadata) await writer.setMetadata(metadata)
        // Every frame is committed, but the manifest has not been published and
        // the catalog has not been completed: `done` is never `ready`.
        notify({ type: 'done' })
      } catch (error) {
        notify({ type: 'failed' })
        throw error
      }
    }
    const done = queue ? queue.submit(build, input.workerRssMb ?? 4096, signal).done : build()
    store.markAdmitted(artifactKey(this.identity(input)))
    onAdmission?.()
    await done
    signal?.throwIfAborted()
  }

  /**
   * Import a pre-generation flat artifact only when every record verifies.
   * Two passes keep a damaged frame from leaving a half-written generation;
   * the caller falls back to a real source parse on any confirmed corruption.
   */
  static async importLegacy(
    store: ArtifactStore,
    identity: ArtifactIdentity,
    input: ArtifactSessionInput,
    writer: ArtifactWriter,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let legacy: ArtifactReader | null
    try { legacy = await store.find(artifactKey(identity)) }
    catch (error) {
      if (error instanceof ArtifactCorruptionError) return false
      throw error
    }
    if (!legacy) return false
    // The flat reader validates artifactKey(manifest.identity) === key already;
    // compare the full identity so a changed option/schema can never be imported.
    if (canonicalJson(legacy.manifest.identity) !== canonicalJson(identity)) return false
    const records = legacy.manifest.records
    const ids = new Set(records.map((record) => record.id))
    if (!records.length || !ids.has('document')) return false
    if (input.format === 'pptx' && !ids.has('external-media')) return false
    let document: StoredDocument
    try { document = (await legacy.read('document')) as unknown as StoredDocument }
    catch (error) {
      if (error instanceof ArtifactCorruptionError) return false
      throw error
    }
    if (!document?.model || document.model.format !== input.format ||
        !Array.isArray(document.fonts)) return false
    for (let index = 0; index < (document.model.unitCount ?? 0); index++)
      if (!ids.has(`unit:${index}`)) return false
    for (const font of document.fonts)
      if (!ids.has(`font:${font.id}`)) return false
    // Verify every frame BEFORE publishing anything into the immutable generation.
    for (const entry of records) {
      signal?.throwIfAborted()
      try { await legacy.read(entry.id) }
      catch (error) {
        if (error instanceof ArtifactCorruptionError) return false
        throw error
      }
    }
    for (const entry of records) {
      signal?.throwIfAborted()
      const value = await legacy.read(entry.id)
      await writer.append(entry.id, value as JsonValue | Uint8Array)
    }
    return true
  }

  /**
   * Import a pre-generation flat offline bundle, symmetric to importLegacy.
   * The bundle manifest is the client's authoritative download inventory, so
   * its declared derived records and hashes are cross-checked against the
   * stored frames. Two passes keep a damaged frame from leaving a half-written
   * generation; any confirmed mismatch falls back to a real bundle build.
   */
  static async importLegacyBundle(
    store: ArtifactStore,
    identity: ArtifactIdentity,
    writer: ArtifactWriter,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const key = artifactKey(identity)
    let legacy: ArtifactReader | null
    try { legacy = await store.find(key) }
    catch (error) {
      if (error instanceof ArtifactCorruptionError) return false
      throw error
    }
    if (!legacy) return false
    // find() enforces artifactKey(manifest.identity) === key; compare the whole
    // identity so a stale model generation/digest can never be imported.
    if (canonicalJson(legacy.manifest.identity) !== canonicalJson(identity)) return false

    const records = legacy.manifest.records
    const ids = new Set(records.map((record) => record.id))
    if (!records.length || !ids.has('bundle') || !ids.has('bundle:layout')) return false
    let manifest: OfflineBundleManifest
    try { manifest = (await legacy.read('bundle')) as unknown as OfflineBundleManifest }
    catch (error) {
      if (error instanceof ArtifactCorruptionError) return false
      throw error
    }
    if (!isLegacyBundleManifest(manifest, identity, key)) return false

    // Every derived frame must be declared, and every declared derived resource
    // must have a frame; otherwise a client could be told to fetch a missing part.
    const declared = new Map<string, OfflineBundleResource>()
    for (const resource of manifest.resources) {
      const id = bundleDerivedId(resource.path)
      if (!id) continue  // model-owned layout/ and fonts/ resources live elsewhere
      if (declared.has(id) || !ids.has(id)) return false
      declared.set(id, resource)
    }
    if (!declared.has('bundle:layout')) return false
    for (const id of ids) if (isDerivedRecord(id) && !declared.has(id)) return false

    // Pass 1: verify every gzip/sha256 frame and cross-check the inventory
    // BEFORE writing anything into the immutable generation.
    for (const entry of records) {
      signal?.throwIfAborted()
      let value: JsonValue | Buffer
      try { value = await legacy.read(entry.id) }
      catch (error) {
        if (error instanceof ArtifactCorruptionError) return false
        throw error
      }
      const resource = declared.get(entry.id)
      if (!resource) continue
      if (entry.id === 'bundle:layout') {
        const described = legacy.describe(entry.id)
        if (described.size !== resource.size || described.sha256 !== resource.sha256) return false
      } else {
        const info = value as unknown as Partial<OfflineBundleResource> | null
        if (
          !info || typeof info !== 'object' || Array.isArray(info) ||
          info.path !== resource.path || info.size !== resource.size ||
          info.sha256 !== resource.sha256
        ) return false
      }
    }
    // Pass 2: only now copy verified frames. A late read error propagates so
    // the coordinator discards staging rather than publishing a partial bundle.
    for (const entry of records) {
      signal?.throwIfAborted()
      const value = await legacy.read(entry.id)
      await writer.append(entry.id, value as JsonValue | Uint8Array)
    }
    return true
  }

  static async open(
    store: ArtifactStore,
    input: ArtifactSessionInput,
    queue?: ParseQueue,
    onAdmission?: () => void,
    demand?: AbortSignal,
  ): Promise<ArtifactSession> {
    const reader = await store.getOrBuild(
      this.identity(input),
      (writer, signal) => this.build(store, input, writer, queue, signal ?? demand),
      onAdmission,
      async (cached) => {
        if (input.format === 'pptx' && !cached.has('external-media'))
          throw new ArtifactCorruptionError('external media index missing')
        if (!cached.has('document'))
          throw new ArtifactCorruptionError('artifact document record missing')
        const document = (await cached.read('document')) as unknown as StoredDocument
        if (
          !document?.model ||
          document.model.format !== input.format ||
          !Array.isArray(document.fonts)
        )
          throw new ArtifactCorruptionError('artifact document schema mismatch')
      },
      demand,
    )
    const document = (await reader.read('document')) as unknown as StoredDocument
    if (document.model.format !== input.format || !Array.isArray(document.fonts))
      throw new Error('artifact document schema mismatch')
    return new ArtifactSession(reader, document, store, input, queue)
  }

  static openShared(store: ArtifactStore, input: ArtifactSessionInput,
    backend: SharedArtifactBackend,
    queue?: ParseQueue, onAdmission?: () => void,
    demand?: AbortSignal): Promise<ArtifactSession> {
    return store.runOwned(input.fileId, async () => {
      const identity = this.identity(input)
      const key = artifactKey(identity)
      /** Attach to or rebuild the shared artifact, then pin exactly one generation. */
      const openOne = async (notify?: () => void): Promise<{
        handle: ArtifactReadHandle; document: StoredDocument
      }> => {
        for (let attempt = 0; ; attempt++) {
          await backend.coordinator.getOrBuild(identity,
            async (writer, signal, jobId) => {
              store.stats.buildsStarted++
              // A verified old-layout cache becomes generation N without re-parsing
              // the source. Damage or version mismatch falls back to a real build.
              if (await this.importLegacy(store, identity, input, writer, signal)) {
                store.stats.legacyImports++
                store.markAdmitted(key)
                notify?.()
                return
              }
              return this.build(store, input, writer, queue, signal, notify, jobId)
            }, undefined, notify, demand)
          const handle = await ArtifactReadHandle.open(backend.catalog, backend.disk, key, `view:${randomUUID()}`)
          if (!handle) throw new Error('ready artifact disappeared before view admission')
          try { return { handle, document: await this.validatePinned(handle, input) } }
          catch (error) {
            await handle.close().catch(() => undefined)
            if (!(error instanceof ArtifactCorruptionError) || attempt >= 1) throw error
            // The handle already reported the damage. Compare-and-clear is idempotent
            // and cannot withdraw a replacement generation published meanwhile.
            await backend.catalog.invalidateReady(handle.artifact)
          }
        }
      }
      const repair: ArtifactRepair = async () => {
        // The view owns its old pin; compare-and-clear cannot affect a replacement
        // generation published by another process in the meantime.
        const handle = session?.reader
        if (handle instanceof ArtifactReadHandle)
          await backend.catalog.invalidateReady(handle.artifact)
        return openOne()
      }
      let session: ArtifactSession | undefined
      try {
        const first = await openOne(onAdmission)
        session = new ArtifactSession(first.handle, first.document, store, input, queue, repair, backend)
        return session
      } finally { store.finishProgress(key) }
    })
  }

  /** Swap in a repaired generation without aborting reads still using the old pin. */
  private adopt(handle: ArtifactReadHandle, document: StoredDocument, previous: ArtifactReadHandle): void {
    this.reader = handle
    this.document = document
    this.fonts = document.fonts
    // Bundle identity includes the model digest; future requests must use the new pin.
    this.bundleOpening = undefined
    this.bundleRepairs = 0
    this.retired.push(previous)
  }

  private repairOnce(): Promise<void> {
    if (!this.repairing) {
      this.repairing = (async () => {
        this.repairs++
        const previous = this.reader
        if (!(previous instanceof ArtifactReadHandle))
          throw new Error('artifact view has no generation pin to repair')
        const next = await this.repair!()
        if (this.closed) { await next.handle.close(); return }
        this.adopt(next.handle, next.document, previous)
      })().finally(() => { this.repairing = undefined })
    }
    return this.repairing
  }

  /** Exactly one transparent rebuild + retry for damage found while a view is open. */
  private async withRepair<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (!(error instanceof ArtifactCorruptionError) || !this.repair || this.repairs >= 1) throw error
      await this.repairOnce()
      this.check()
      return await operation()
    }
  }

  private readRecord(id: string): Promise<JsonValue | Buffer> {
    return this.withRepair(() => this.reader.read(id))
  }

  private static async validatePinned(handle: ArtifactReadHandle,
    input: ArtifactSessionInput): Promise<StoredDocument> {
    if (handle.manifest.key !== artifactKey(this.identity(input)))
      throw new ArtifactCorruptionError('artifact session identity mismatch')
    if (input.format === 'pptx' && !handle.has('external-media'))
      throw new ArtifactCorruptionError('external media index missing')
    const document = (await handle.read('document')) as unknown as StoredDocument
    if (!document?.model || document.model.format !== input.format || !Array.isArray(document.fonts))
      throw new ArtifactCorruptionError('artifact document schema mismatch')
    return document
  }

  /** Adopt a dedicated view pin; the caller must not share this handle with another view. */
  static async openPinned(handle: ArtifactReadHandle, store: ArtifactStore,
    input: ArtifactSessionInput, queue?: ParseQueue, repair?: ArtifactRepair): Promise<ArtifactSession> {
    try {
      const document = await this.validatePinned(handle, input)
      return new ArtifactSession(handle, document, store, input, queue, repair)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  private check(): void {
    if (this.closed) throw new Error('document session is closed')
    if (this.reader instanceof ArtifactReadHandle) this.reader.signal.throwIfAborted()
  }

  private bundleIdentity(): ArtifactIdentity {
    return {
      ...ArtifactSession.identity(this.input),
      options: normalizeArtifactOptions({
        purpose: 'offline-bundle',
        modelArtifactKey: this.reader.manifest.key,
        modelContentDigest: this.reader.contentDigest,
      }),
    }
  }

  private async ensureBundle(): Promise<BundleReader> {
    this.check()
    if (this.model.format !== 'pptx' && this.model.format !== 'docx') throw new Error('unsupported offline document')
    if (!this.bundleOpening) {
      const identity = this.bundleIdentity()
      const task = this.shared
        ? this.openSharedBundle(identity, this.shared)
        : this.openLocalBundle(identity)
      this.bundleOpening = task
      void task.catch(() => {
        if (this.bundleOpening === task) this.bundleOpening = undefined
      })
    }
    return this.bundleOpening
  }

  /** Legacy flat bundle, used only by the single-process backend. */
  private openLocalBundle(identity: ArtifactIdentity): Promise<ArtifactReader> {
    return this.store.runOwned(this.input.fileId, () => this.store.getOrBuild(identity,
      async (writer) => {
        this.store.markRunning(artifactKey(identity))
        await this.runBundleBuild(identity, writer)
      }))
  }

  /**
   * Derived bundle as its own catalog generation, with a view-owned read lease.
   * The source model generation is forked for the whole build so its bytes stay
   * pinned while the bundle hashes the archived package.
   */
  private async openSharedBundle(identity: ArtifactIdentity,
    backend: SharedArtifactBackend): Promise<ArtifactReadHandle> {
    const key = artifactKey(identity)
    return this.store.runOwned(this.input.fileId, async () => {
      try {
        const ensurePublished = () => backend.coordinator.getOrBuild(identity,
          async (writer, signal) => {
            this.store.stats.buildsStarted++
            this.store.markRunning(key)
            // A verified old flat bundle becomes a generation without re-hashing
            // the source ZIP or forking the model pin. Any mismatch rebuilds it.
            if (await ArtifactSession.importLegacyBundle(this.store, identity, writer, signal)) {
              this.store.stats.legacyBundleImports++
              this.store.markAdmitted(key)
              return
            }
            await this.runBundleBuild(identity, writer, signal)
          })
        await ensurePublished()
        let handle = await ArtifactReadHandle.open(backend.catalog, backend.disk, key,
          `bundle:${randomUUID()}`)
        if (!handle) {
          // Another process may withdraw the ready pointer between publish and pin.
          await ensurePublished()
          handle = await ArtifactReadHandle.open(backend.catalog, backend.disk, key,
            `bundle:${randomUUID()}`)
        }
        if (!handle) throw new Error('ready bundle artifact disappeared before view admission')
        if (handle.manifest.key !== key) {
          await handle.close()
          throw new ArtifactCorruptionError('offline bundle identity mismatch')
        }
        // Record the derived-bundle dependency graph (plan §5): the bundle was
        // hashed from this model generation and its media resolve from the file.
        if (typeof backend.catalog.recordDependency === 'function')
          await backend.catalog
            .recordDependency(key, 'artifact', this.reader.manifest.key)
            .catch(() => undefined)
        this.bundlePins.push(handle)
        return handle
      } finally { this.store.finishProgress(key) }
    })
  }

  private async runBundleBuild(identity: ArtifactIdentity, writer: ArtifactWriter,
    signal?: AbortSignal): Promise<void> {
    const source = this.reader instanceof ArtifactReadHandle
      ? await this.reader.fork(`bundle:${randomUUID()}`) : this.reader
    try {
      const build = async () => {
        signal?.throwIfAborted()
        const external = this.model.format === 'pptx' ? (await source.read('external-media')) as string[] : []
        await writer.setMetadata({ dependencies: [source.manifest.key] })
        if (this.model.format === 'docx') {
          await writeDocxOfflineBundle(writer, { ...this.input, artifactKey: artifactKey(identity),
            modelArtifactKey: source.manifest.key, modelSchemaVersion: MODEL_SCHEMA_VERSION },
            this.document as never, (id) => source.describe(id), (id) => source.read(id))
          return
        }
        await writeOfflineBundle(
          writer,
          {
            ...this.input,
            artifactKey: artifactKey(identity),
            modelArtifactKey: source.manifest.key,
            modelSchemaVersion: MODEL_SCHEMA_VERSION,
          },
          this.document.layout!,
          new Set(external),
          (id) => source.describe(id),
        )
      }
      const run = (active?: AbortSignal) => this.queue
        ? this.queue.run(build, Math.min(this.input.workerRssMb ?? 4096, 512), active) : build()
      if (source instanceof ArtifactReadHandle)
        await source.use((forkSignal) => run(
          signal ? AbortSignal.any([signal, forkSignal]) : forkSignal))
      else await run(signal)
    } finally {
      if (source instanceof ArtifactReadHandle) await source.close()
    }
  }

  /** A damaged derived bundle must not stay cached in this view. */
  private async readBundleRecord(reader: BundleReader, id: string): Promise<JsonValue | Buffer> {
    try { return await reader.read(id) }
    catch (error) {
      if (error instanceof ArtifactCorruptionError) this.bundleOpening = undefined
      throw error
    }
  }

  /** Exactly one transparent rebuild + retry of the derived generation per view. */
  private async withBundleRepair<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (!(error instanceof ArtifactCorruptionError) || !this.shared || this.bundleRepairs >= 1)
        throw error
      this.bundleRepairs++
      this.bundleOpening = undefined
      this.check()
      return await operation()
    }
  }

  async bundleManifest(): Promise<OfflineBundleManifest> {
    return this.withBundleRepair(async () => {
      const reader = await this.ensureBundle()
      this.check()
      return (await this.readBundleRecord(reader, 'bundle')) as unknown as OfflineBundleManifest
    })
  }

  async bundleResource(
    path: string,
  ): Promise<{ info: OfflineBundleResource; bytes?: Buffer; partPath?: string } | null> {
    this.check()
    if (!validBundlePath(path)) return null
    // Records owned by the derived bundle generation use its own repair path.
    const derived = await this.withBundleRepair(async () => {
      const bundle = await this.ensureBundle()
      this.check()
      if (path.startsWith('parts/')) {
        const partPath = path.slice(6)
        if (!bundle.has(`bundle:part:${partPath}`)) return null
        const info = (await this.readBundleRecord(bundle,
          `bundle:part:${partPath}`,
        )) as unknown as OfflineBundleResource
        return { info, partPath }
      }
      if (path === 'layout.json' || path === 'document.json') {
        const record = path === 'layout.json' ? 'bundle:layout' : 'bundle:document'
        if (!bundle.has(record)) return null
        const value = await this.readBundleRecord(bundle, record)
        return {
          info: { path, ...bundle.describe(record) },
          bytes: Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value)),
        }
      }
      return null
    })
    if (derived) return derived
    // Model records (layout pages and embedded fonts) keep the model repair path.
    let id: string | undefined
    if ((this.model.format === 'docx' ? /^units\/(0|[1-9]\d*)\.json$/ : /^layout\/(0|[1-9]\d*)\.json$/).test(path))
      id = `unit:${path.split('/')[1].slice(0, -5)}`
    else if (path === 'styles.json' && this.model.format === 'docx') id = 'styles'
    else if (path.startsWith('fonts/') && path.endsWith('.sfnt')) {
      const match = /^fonts\/font-(0|[1-9]\d*)\.sfnt$/.exec(path)
      const font = match ? this.fonts[Number(match[1])] : undefined
      if (font) id = `font:${font.id}`
    }
    if (!id || !this.reader.has(id)) return null
    const value = await this.readRecord(id)
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value))
    return { info: { path, ...this.reader.describe(id) }, bytes }
  }

  async layoutInfo(): Promise<PptxLayoutInfo> {
    this.check()
    if (!this.document.layout) throw new Error('layout is only available for PPTX')
    return this.document.layout
  }

  async layoutModel(unitId: string): Promise<PptxLayoutSlide> {
    this.check()
    this.validateUnit(unitId)
    if (this.model.format !== 'pptx') throw new Error('layout is only available for PPTX')
    return refreshDocxResourceUrls(
      await this.readRecord(`unit:${unitId}`),
      this.input.fileId,
      this.input.baseUrl,
      this.input.mediaSecret,
    ) as PptxLayoutSlide
  }

  private validateUnit(id: string): void {
    if (!/^(0|[1-9]\d*)$/.test(id) || Number(id) >= (this.model.unitCount ?? 0))
      throw new Error('unknown document unit')
  }

  async unit(id: string): Promise<unknown> {
    this.check()
    this.validateUnit(id)
    if (this.model.format === 'pptx') {
      const layoutRssMb = Math.min(
        this.input.workerRssMb ?? 4096,
        Math.max(1024, this.input.workerMemoryMb + 256),
      )
      const layout = async (signal?: AbortSignal) => {
        this.check()
        const renderer = await PptxSession.openCached(
          { ...this.input, signal, workerRssMb: layoutRssMb, measuredWidths: { ...this.widths } },
          this.store.root,
          this.reader.manifest.key,
          this.reader instanceof ArtifactReadHandle ? this.reader.artifact : undefined,
        )
        this.renderers.add(renderer)
        try {
          this.check()
          const unit = await renderer.unit(id)
          for (const item of unit.measurements) this.pendingWidths.set(item.key, item)
          return { ...unit, measurements: [...this.pendingWidths.values()] }
        } finally {
          this.renderers.delete(renderer)
          await renderer.dispose()
        }
      }
      const render = (signal?: AbortSignal) => this.queue
        ? this.queue.run(() => layout(signal), layoutRssMb, signal) : layout(signal)
      // The isolated renderer opens its own copy of this generation; a damaged
      // frame is reported over IPC as a corruption error, not a worker crash.
      return this.withRepair(async () => {
        const work = this.reader instanceof ArtifactReadHandle ? this.reader.use(render) : render()
        this.renderFlights.add(work)
        void work.finally(() => this.renderFlights.delete(work)).catch(() => undefined)
        return work
      })
    }
    return this.readRecord(`unit:${id}`)
  }

  async styleContext(): Promise<unknown> {
    this.check()
    if (this.model.format !== 'docx') throw new Error('styles are only available for DOCX')
    return this.readRecord('styles')
  }
  async fontBytes(id: string): Promise<Uint8Array | null> {
    this.check()
    if (!this.fonts.some((font) => font.id === id)) return null
    return (await this.readRecord(`font:${id}`)) as Buffer
  }
  async acceptWidths(widths: Readonly<Record<string, number>>): Promise<unknown[]> {
    this.check()
    for (const [key, width] of Object.entries(widths)) {
      if (!this.pendingWidths.has(key) || !Number.isFinite(width) || width < 0) continue
      this.widths[key] = width
      this.pendingWidths.delete(key)
    }
    return [...this.pendingWidths.values()]
  }
  get activeWorkers(): number {
    return this.renderers.size
  }
  close(): void {
    this.closed = true
    for (const renderer of this.renderers) renderer.close()
    this.renderers.clear()
    this.pendingWidths.clear()
    for (const handle of [this.reader, ...this.retired, ...this.bundlePins])
      if (handle instanceof ArtifactReadHandle) void handle.close().catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.close()
    await Promise.allSettled([...this.renderFlights])
    for (const handle of [this.reader, ...this.retired, ...this.bundlePins])
      if (handle instanceof ArtifactReadHandle) await handle.close()
  }
}
