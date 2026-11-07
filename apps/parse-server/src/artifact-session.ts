import type { MysqlArtifactCatalog } from './artifact-catalog'
import type { ArtifactGenerations } from './artifact-generations'
import type { ArtifactCoordinator } from './artifact-coordinator'
import { randomUUID } from 'node:crypto'
import { ArtifactReadHandle } from './artifact-read-handle'
import { writeOfflineBundle, externalMedia, validBundlePath } from './offline-bundle'
import type { OfflineBundleManifest, OfflineBundleResource } from '@genoffice/parse-contract'
import type { WidthItem } from './metrics'
import type { ParseQueue } from './parse-queue'
import type { DocModel } from '@genoffice/parse-contract'
import {
  ArtifactStore,
  ArtifactCorruptionError,
  artifactKey,
  canonicalJson,
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

export const MODEL_SCHEMA_VERSION = 2

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

interface StoredDocument {
  model: DocModel
  fonts: PptxFontSummary[]
  layout?: PptxLayoutInfo
}

export interface ArtifactSessionInput extends PptxOpenInput {
  format: 'pptx' | 'docx'
  parserFingerprint: string
  chunkRoot: string
}

/** One lightweight reader per viewing session; parsing is shared by artifact identity. */
export class ArtifactSession {
  readonly model: DocModel
  readonly fonts: PptxFontSummary[]
  private readonly widths: Record<string, number> = {}
  private readonly pendingWidths = new Map<string, WidthItem>()
  private readonly renderers = new Set<PptxSession>()
  private readonly renderFlights = new Set<Promise<unknown>>()
  private closed = false
  private bundleOpening?: Promise<ArtifactReader>

  private constructor(
    readonly reader: ArtifactReader | ArtifactReadHandle,
    private readonly document: StoredDocument,
    private readonly store: ArtifactStore,
    private readonly input: ArtifactSessionInput,
    private readonly queue?: ParseQueue,
  ) {
    this.model = document.model
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
      options: {},
    }
  }

  /** Shared source build used by both storage backends; signal belongs to the build, never a viewer. */
  static async build(store: ArtifactStore, input: ArtifactSessionInput, writer: ArtifactWriter,
    queue?: ParseQueue, signal?: AbortSignal, onAdmission?: () => void): Promise<void> {
    const build = async () => {
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
        if (parser instanceof PptxSession) document.layout = await parser.layoutInfo()
        else await writer.append('styles', modelDto(await parser.styleContext()))
        await writer.append('document', modelDto(document))
        const external = new Set<string>()
        for (let index = 0; index < (parser.model.unitCount ?? 0); index++) {
          signal?.throwIfAborted()
          const unit =
            parser instanceof PptxSession
              ? await parser.layoutModel(String(index))
              : await parser.unit(String(index))
          signal?.throwIfAborted()
          await writer.append(`unit:${index}`, canonicalResources(modelDto(unit), input.fileId))
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
      } finally {
        try {
          await parser?.dispose()
          await removeChunks(chunksDir)
        } finally {
          await scratch?.release()
        }
      }
    }
    const done = queue ? queue.submit(build, input.workerRssMb ?? 4096, signal).done : build()
    store.markAdmitted(artifactKey(this.identity(input)))
    onAdmission?.()
    await done
    signal?.throwIfAborted()
  }

  static async open(
    store: ArtifactStore,
    input: ArtifactSessionInput,
    queue?: ParseQueue,
    onAdmission?: () => void,
  ): Promise<ArtifactSession> {
    const reader = await store.getOrBuild(
      this.identity(input),
      (writer) => this.build(store, input, writer, queue),
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
    )
    const document = (await reader.read('document')) as unknown as StoredDocument
    if (document.model.format !== input.format || !Array.isArray(document.fonts))
      throw new Error('artifact document schema mismatch')
    return new ArtifactSession(reader, document, store, input, queue)
  }

  static openShared(store: ArtifactStore, input: ArtifactSessionInput,
    backend: { catalog: MysqlArtifactCatalog; disk: ArtifactGenerations; coordinator: ArtifactCoordinator },
    queue?: ParseQueue, onAdmission?: () => void): Promise<ArtifactSession> {
    return store.runOwned(input.fileId, async () => {
      const identity = this.identity(input)
      try {
        for (let attempt = 0; ; attempt++) {
          await backend.coordinator.getOrBuild(identity,
            (writer, signal) => {
              store.stats.buildsStarted++
              return this.build(store, input, writer, queue, signal, onAdmission)
            }, undefined, onAdmission)
          const handle = await ArtifactReadHandle.open(backend.catalog, backend.disk, artifactKey(identity), `view:${randomUUID()}`)
          if (!handle) throw new Error('ready artifact disappeared before view admission')
          try { return await this.openPinned(handle, store, input, queue) }
          catch (error) {
            if (!(error instanceof ArtifactCorruptionError) || attempt >= 1) throw error
            // openPinned has released this failed view; compare-and-clear cannot affect a replacement.
            await backend.catalog.invalidateReady(handle.artifact)
          }
        }
      } finally { store.finishProgress(artifactKey(identity)) }
    })
  }

  /** Adopt a dedicated view pin; the caller must not share this handle with another view. */
  static async openPinned(handle: ArtifactReadHandle, store: ArtifactStore,
    input: ArtifactSessionInput, queue?: ParseQueue): Promise<ArtifactSession> {
    try {
      if (handle.manifest.key !== artifactKey(this.identity(input)))
        throw new ArtifactCorruptionError('artifact session identity mismatch')
      if (input.format === 'pptx' && !handle.has('external-media'))
        throw new ArtifactCorruptionError('external media index missing')
      const document = (await handle.read('document')) as unknown as StoredDocument
      if (!document?.model || document.model.format !== input.format || !Array.isArray(document.fonts))
        throw new ArtifactCorruptionError('artifact document schema mismatch')
      return new ArtifactSession(handle, document, store, input, queue)
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  private check(): void {
    if (this.closed) throw new Error('document session is closed')
    if (this.reader instanceof ArtifactReadHandle) this.reader.signal.throwIfAborted()
  }

  private async ensureBundle(): Promise<ArtifactReader> {
    this.check()
    if (this.model.format !== 'pptx') throw new Error('offline bundles currently require PPTX')
    if (!this.bundleOpening) {
      const identity = {
        ...ArtifactSession.identity(this.input),
        options: {
          purpose: 'offline-bundle',
          modelArtifactKey: this.reader.manifest.key,
          modelContentDigest: this.reader.contentDigest,
        },
      }
      const task = this.store.runOwned(this.input.fileId, async () => {
        const source = this.reader instanceof ArtifactReadHandle
          ? await this.reader.fork(`bundle:${randomUUID()}`) : this.reader
        try {
          return await this.store.getOrBuild(identity, async (writer) => {
            const build = async () => {
              this.store.markRunning(artifactKey(identity))
              const external = (await source.read('external-media')) as string[]
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
            const run = (signal?: AbortSignal) => this.queue
              ? this.queue.run(build, Math.min(this.input.workerRssMb ?? 4096, 512), signal) : build()
            if (source instanceof ArtifactReadHandle) await source.use(run)
            else await run()
          })
        } finally {
          if (source instanceof ArtifactReadHandle) await source.close()
        }
      })
      this.bundleOpening = task
      void task.catch(() => {
        if (this.bundleOpening === task) this.bundleOpening = undefined
      })
    }
    return this.bundleOpening
  }

  async bundleManifest(): Promise<OfflineBundleManifest> {
    const reader = await this.ensureBundle()
    this.check()
    return (await reader.read('bundle')) as unknown as OfflineBundleManifest
  }

  async bundleResource(
    path: string,
  ): Promise<{ info: OfflineBundleResource; bytes?: Buffer; partPath?: string } | null> {
    this.check()
    if (this.model.format !== 'pptx' || !validBundlePath(path)) return null
    const bundle = await this.ensureBundle()
    this.check()
    let id: string | undefined
    if (path === 'layout.json') id = 'bundle:layout'
    else if (/^layout\/(0|[1-9]\d*)\.json$/.test(path)) id = `unit:${path.slice(7, -5)}`
    else if (path.startsWith('fonts/') && path.endsWith('.sfnt')) {
      const match = /^fonts\/font-(0|[1-9]\d*)\.sfnt$/.exec(path)
      const font = match ? this.fonts[Number(match[1])] : undefined
      if (font) id = `font:${font.id}`
    } else if (path.startsWith('parts/')) {
      const partPath = path.slice(6)
      if (!bundle.has(`bundle:part:${partPath}`)) return null
      const info = (await bundle.read(
        `bundle:part:${partPath}`,
      )) as unknown as OfflineBundleResource
      return { info, partPath }
    }
    const source = id === 'bundle:layout' ? bundle : this.reader
    if (!id || !source.has(id)) return null
    const value = await source.read(id)
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value))
    return { info: { path, ...source.describe(id) }, bytes }
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
      await this.reader.read(`unit:${unitId}`),
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
      const work = this.reader instanceof ArtifactReadHandle ? this.reader.use(render) : render()
      this.renderFlights.add(work)
      void work.finally(() => this.renderFlights.delete(work)).catch(() => undefined)
      return work
    }
    return this.reader.read(`unit:${id}`)
  }

  async styleContext(): Promise<unknown> {
    this.check()
    if (this.model.format !== 'docx') throw new Error('styles are only available for DOCX')
    return this.reader.read('styles')
  }
  async fontBytes(id: string): Promise<Uint8Array | null> {
    this.check()
    if (!this.fonts.some((font) => font.id === id)) return null
    return (await this.reader.read(`font:${id}`)) as Buffer
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
    if (this.reader instanceof ArtifactReadHandle) void this.reader.close().catch(() => undefined)
  }

  async dispose(): Promise<void> {
    this.close()
    await Promise.allSettled([...this.renderFlights])
    if (this.reader instanceof ArtifactReadHandle) await this.reader.close()
  }
}
