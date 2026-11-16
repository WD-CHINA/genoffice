/**
 * The versioned contract between the Viewer (browser) and the parse server.
 *
 * Deliberately pure: no DOM, Node or Electron imports, so the same types are
 * usable from the Viewer bundle, a Worker and a Node service. The server-side
 * wire payloads are a subset of these types; see `docs/parse-backend-architecture.zh-CN.md`.
 */

/** Bumped whenever a breaking wire change lands. Mixed versions must not share a session. */
export const API_VERSION = 1
export const CONTRACT_VERSION = API_VERSION

/** Formats the Viewer can display locally or through the parse service. */
export type DocFormat = 'pptx' | 'pdf' | 'docx'

/** Formats the remote provider can parse. */
export type RemoteFormat = Extract<DocFormat, 'pptx' | 'pdf' | 'docx'>

export function isRemoteFormat(format: DocFormat): format is RemoteFormat {
  return format === 'pptx' || format === 'pdf' || format === 'docx'
}

/** A file already accepted by the server, addressed by content hash. */
export interface FileRef {
  fileId: string
  size: number
  sha256: string
  format: DocFormat
  /** True when the container itself is encrypted (the password is never stored). */
  encrypted?: boolean
}

/**
 * Random-access byte source. Local files, a Node file handle and an HTTP
 * Range-backed reader all implement it; the parser core never assumes the
 * whole file is resident.
 */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
  close?(): Promise<void>
}

/** Stages a parser can complete. Stage 4 (DOM measure/pagination) always stays in the browser. */
export type ParseStage = 'index' | 'model' | 'layout' | 'measure' | 'pagination'

/** Compatibility marker for the same v1 HTTP contract. */
export const PARSE_DTO_VERSION = API_VERSION

export interface Capabilities {
  contractVersion: number
  /** Optional DTO envelope version; absent on older servers. */
  dtoVersion?: number
  parserVersion: string
  /** Remote capabilities must only list formats the server actually parses (pptx/pdf). */
  formats: DocFormat[]
  /** Which stages each format can reach on this provider. */
  stages: Partial<Record<DocFormat, ParseStage[]>>
  maxBytes: number
  /** Font-set fingerprint; local and remote must agree before results are comparable. */
  fontSetHash: string
  /**
   * Client routing thresholds advertised by the deployment (plan §8.1). Optional
   * for older servers; clients fall back to their own defaults when absent.
   */
  thresholds?: {
    docxAutoRemoteBytes: number
    pptxAutoRemoteBytes: number
    docxFullRenderBytes: number
  }
  features: {
    lazyAssets: boolean
    mediaTranscoding?: boolean
    mediaPreparationIntegrity?: boolean
    rangeRequests: boolean
    fontWidthFeedback: boolean
    streamingUnits: boolean
    asyncSessions?: boolean
    historyLibrary?: boolean
    offlineBundles?: boolean
    /** Building sessions may expose already-committed units before `ready`. */
    incrementalPreview?: boolean
  }
}

export interface ParseOptions {
  /** Stages requested from the provider; defaults to everything it advertises. */
  stages?: ParseStage[]
  /** Soft cap for one serialized unit; the provider splits larger ones. */
  maxUnitBytes?: number
  locale?: string
  /** Fonts the browser already has loaded, for the PPTX width-feedback loop. */
  fonts?: Array<{ id: string; family: string; bold: boolean; italic: boolean }>
}

export type UnitKind = 'slide' | 'pdf-page' | 'block-chunk'

export interface UnitSummary {
  id: string
  kind: UnitKind
  index: number
  /** Stable anchor shared by local and remote parses (PPTX sourceId, PDF page number). */
  anchor: string
  bytes?: number
}

export interface DocPageSettings {
  /** Page width in twips. */
  pageWidth: number
  /** Page height in twips. */
  pageHeight: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

/** Serializable DOCX section geometry. Rich header/footer payloads stay JSON objects. */
export interface DocxLayoutData {
  sections: Array<{
    firstBlockIndex: number
    lastBlockIndex: number
    settings: DocPageSettings & { columns: number; colSpace?: number; colWidths?: number[] }
    startType: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn'
    titlePg: boolean
    headerRefs: Partial<Record<'default' | 'first' | 'even', string>>
    footerRefs: Partial<Record<'default' | 'first' | 'even', string>>
  }>
  hfParts: Record<string, object>
  evenAndOddHeaders: boolean
  mirrorMargins: boolean
  footnotes: object[]
  endnotes: object[]
  noteNumbers: Record<string, number>
  footnoteProps?: { numFmt?: string; numStart?: number; numRestart?: string }
  endnoteProps?: { numFmt?: string; numStart?: number; numRestart?: string }
}

export interface DocModel {
  format: DocFormat
  parserVersion: string
  unitKind: UnitKind
  /** Unknown until an index pass completes; never force a full scan just to report a count. */
  unitCount?: number
  /** Snapshot at one moment; progressive state comes from the session endpoint. */
  stagesDone: ParseStage[]
  stagesPending: ParseStage[]
  /** Asset count only; assets themselves are paged through `ParseSession.assets`. */
  assetCount?: number
  /** Page geometry for paginated formats (DOCX sections). */
  page?: DocPageSettings
  /** Document-wide context shared by bounded DOCX body chunks. */
  docx?: DocxLayoutData
  warnings: Diagnostic[]
}

export interface AssetRef {
  id: string
  kind: 'image' | 'media' | 'font'
  mime: string
  bytes: number
  /** Content hash, also the cache key. */
  sha256: string
  /** Position inside the container (PPTX zip entry) or the original file. */
  partPath?: string
  /** Derived resources: source hash plus the transform version that produced this. */
  transform?: { sourceSha256: string; version: string }
  /** Lazy resource: the client GETs this instead of receiving bytes inline. */
  url: string
}

export interface Diagnostic {
  code: string
  severity: 'info' | 'warning' | 'error'
  message: string
  unitId?: string
}

export interface ParseInput {
  format: DocFormat
  /** Local provider receives a ByteSource; remote receives the uploaded FileRef. */
  source: ByteSource | FileRef
  options: ParseOptions
  signal: AbortSignal
}

export interface TextWidthBatch {
  batchId: string
  renderRevision: number
  widths: Array<{ key: string; width: number }>
}

export interface ParseSession {
  readonly provider: 'local' | 'remote'
  /** May be an index-only model; `stagesPending` says what is still missing. */
  model(): Promise<DocModel>
  units(cursor?: string, limit?: number): Promise<{ items: UnitSummary[]; next?: string }>
  unit(id: string): Promise<unknown>
  /** Assets are paged: a media-heavy deck must never enumerate every asset up front. */
  assets(cursor?: string, limit?: number): Promise<{ items: AssetRef[]; next?: string }>
  asset(ref: AssetRef): Promise<Blob | URL>
  /** PPTX width feedback; only when the provider advertises `fontWidthFeedback`. */
  submitTextWidths?(batch: TextWidthBatch): Promise<void>
  close(): Promise<void>
}

export interface ParseProvider {
  readonly kind: 'local' | 'remote'
  capabilities(): Promise<Capabilities>
  open(input: ParseInput): Promise<ParseSession>
}

export type ParseMode = 'auto' | 'local' | 'server'

export interface SwitchPolicy {
  mode: ParseMode
  /** Per-format local thresholds; missing means "remote only" (0). */
  localMaxBytes: Partial<Record<DocFormat, number>>
  /** Uploads always need explicit consent unless this is true (default false). */
  allowUploadWithoutConsent: boolean
  /** Enterprise/privacy policy: never upload, even when the file is too large. */
  privacyLocalOnly: boolean
}

export type ProviderKind = 'local' | 'remote' | 'blocked'

export interface ProviderDecision {
  provider: ProviderKind
  /** Stable machine-readable reason, useful for UI copy and tests. */
  reason: string
}

/**
 * Pick a provider from the user's policy, the file and the advertised
 * capabilities. Never silently falls back to local for a file that is too
 * large: that path ends in an out-of-memory tab, so it is a `blocked` decision.
 */
export function decideProvider(input: {
  policy: SwitchPolicy
  size: number
  format: DocFormat
  localCaps: Capabilities
  remoteCaps?: Capabilities
  online: boolean
}): ProviderDecision {
  const localMax = input.policy.localMaxBytes[input.format] ?? 0
  const localFits = input.size <= localMax
  const remoteSupported = input.remoteCaps?.formats.includes(input.format) ?? false

  if (input.policy.privacyLocalOnly) {
    return localFits
      ? { provider: 'local', reason: 'privacy-policy' }
      : { provider: 'blocked', reason: 'privacy-policy-too-large' }
  }
  if (input.policy.mode === 'local') {
    return localFits
      ? { provider: 'local', reason: 'user-forced-local' }
      : { provider: 'blocked', reason: 'user-forced-local-too-large' }
  }
  if (input.policy.mode === 'server') {
    return remoteSupported
      ? { provider: 'remote', reason: 'user-forced-server' }
      : { provider: 'blocked', reason: 'server-unsupported-format' }
  }

  const localSupported = input.localCaps.formats.includes(input.format)
  if (!localSupported && remoteSupported) return { provider: 'remote', reason: 'format-not-local' }
  if (localFits) return { provider: 'local', reason: 'small-file' }
  if (remoteSupported && input.online) return { provider: 'remote', reason: 'large-file' }
  return { provider: 'blocked', reason: 'too-large-or-unsupported' }
}

/** Two providers may only share results when contract and parser versions match. */
export function isCompatible(
  a: { contractVersion: number; parserVersion: string },
  b: { contractVersion: number; parserVersion: string },
): boolean {
  return a.contractVersion === b.contractVersion && a.parserVersion === b.parserVersion
}

const UNIT_KINDS: ReadonlySet<string> = new Set(['slide', 'pdf-page'])
const STAGES: ReadonlySet<string> = new Set(['index', 'model', 'layout', 'measure', 'pagination'])

function isStage(value: unknown): value is ParseStage {
  return typeof value === 'string' && STAGES.has(value)
}

/** Runtime guard for a wire model; a server upgrade must fail here, not deep inside rendering. */
export function assertDocModel(value: unknown): asserts value is DocModel {
  if (!value || typeof value !== 'object') throw new Error('parse-contract: model is not an object')
  const model = value as Partial<DocModel>
  if (model.format !== 'pptx' && model.format !== 'pdf' && model.format !== 'docx') {
    throw new Error(`parse-contract: unknown format ${String(model.format)}`)
  }
  if (typeof model.parserVersion !== 'string' || !model.parserVersion) {
    throw new Error('parse-contract: missing parserVersion')
  }
  if (!UNIT_KINDS.has(String(model.unitKind))) {
    throw new Error(`parse-contract: unknown unitKind ${String(model.unitKind)}`)
  }
  if (
    model.unitCount !== undefined &&
    (!Number.isInteger(model.unitCount) || model.unitCount < 0)
  ) {
    throw new Error('parse-contract: unitCount must be a non-negative integer')
  }
  if (!Array.isArray(model.stagesDone) || !model.stagesDone.every(isStage)) {
    throw new Error('parse-contract: stagesDone must contain parse stages')
  }
  if (!Array.isArray(model.stagesPending) || !model.stagesPending.every(isStage)) {
    throw new Error('parse-contract: stagesPending must contain parse stages')
  }
  if (!Array.isArray(model.warnings)) throw new Error('parse-contract: warnings must be an array')
}

/** Immutable bytes for one PPTX offline bundle; URLs are attached per viewing session. */
export interface OfflineBundleResource {
  path: string
  size: number
  sha256: string
  href?: string
}
export interface OfflineBundleManifest {
  bundleSchemaVersion: 1
  modelSchemaVersion: number
  artifactKey: string
  modelArtifactKey: string
  fileId: string
  format: 'pptx' | 'docx'
  parserVersion: string
  parserFingerprint: string
  unitCount: number
  fonts: Array<{
    id: string
    family: string
    bold: boolean
    italic: boolean
    also: string[]
    resourcePath: string
  }>
  /** Includes every stripped media/embedding entry, even ones unused by the rendered document. */
  inventory: 'ppt-media-v1' | 'docx-media-v1'
  totalBytes: number
  resources: OfflineBundleResource[]
  externalResources: string[]
}

/** Independent media preparation; document artifacts remain immutable. */
export interface MediaPreparation {
  jobId: string
  state: 'queued' | 'processing' | 'ready' | 'failed'
  stage: 'queued' | 'probing' | 'converting' | 'verifying' | 'ready' | 'failed'
  progress: number
  kind: 'video' | 'audio'
  strategy?: 'reuse' | 'remux' | 'transcode'
  cacheHit?: boolean
  url?: string
  mime?: string
  bytes?: number
  /** Ready output identity for verified offline downloads. */
  sha256?: string
  sourceSha256?: string
  profile?: string
  errorCode?: string
}
