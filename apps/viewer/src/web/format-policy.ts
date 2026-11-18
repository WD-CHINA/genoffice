/**
 * Central format routing policy (plan §8.1 item 1).
 *
 * Thresholds used to live as duplicated constants in host/docs-server; they are
 * defined once here and combined with the server's advertised capabilities so a
 * viewer never claims a server path the deployment did not enable.
 */
import type { ServerCapabilities } from './capabilities'

export type DocFormat = 'pptx' | 'pdf' | 'docx'
export type ParseMode = 'auto' | 'local' | 'server'

export const FORMAT_POLICY = {
  /** Anything larger is rejected before upload, matching the server default. */
  maxFileBytes: 1024 * 1024 * 1024,
  /** Automatic routing prefers the service above this size; manual local mode remains available. */
  docxAutoRemoteBytes: 32 * 1024 * 1024,
  /** auto mode sends larger PPTX/PDF to the server; smaller ones stay local. */
  pptxAutoRemoteBytes: 64 * 1024 * 1024,
  /** Full-document DOCX render fallback limit in server mode. */
  docxServerFullRenderBytes: 64 * 1024 * 1024,
} as const

export class FormatPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormatPolicyError'
  }
}

export interface RouteInput {
  mode: ParseMode
  serverUrl?: string
  format: DocFormat
  size: number
  capabilities?: ServerCapabilities
}

export interface RouteDecision {
  mode: 'local' | 'server'
  reason: string
}

export interface FormatThresholds {
  docxAutoRemoteBytes: number
  pptxAutoRemoteBytes: number
  docxFullRenderBytes: number
}

const DEFAULT_THRESHOLDS: FormatThresholds = {
  docxAutoRemoteBytes: FORMAT_POLICY.docxAutoRemoteBytes,
  pptxAutoRemoteBytes: FORMAT_POLICY.pptxAutoRemoteBytes,
  docxFullRenderBytes: FORMAT_POLICY.docxServerFullRenderBytes,
}

/** Deployment-advertised thresholds, falling back to the centralized defaults. */
export function thresholdsOf(capabilities?: ServerCapabilities): FormatThresholds {
  const advertised = capabilities?.thresholds
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  return {
    docxAutoRemoteBytes: pick(
      advertised?.docxAutoRemoteBytes,
      DEFAULT_THRESHOLDS.docxAutoRemoteBytes,
    ),
    pptxAutoRemoteBytes: pick(
      advertised?.pptxAutoRemoteBytes,
      DEFAULT_THRESHOLDS.pptxAutoRemoteBytes,
    ),
    docxFullRenderBytes: pick(
      advertised?.docxFullRenderBytes,
      DEFAULT_THRESHOLDS.docxFullRenderBytes,
    ),
  }
}

/**
 * Manual server mode always uses the remote model. The exact full-document
 * local renderer is a fidelity fallback that must be requested explicitly
 * (`docxLocalFallback=1`), and only for files under the full-render limit.
 */
export function chooseDocxServerRoute(input: {
  size: number
  allowLocalFallback: boolean
  thresholds?: FormatThresholds
}): 'local-full' | 'remote' {
  if (!input.allowLocalFallback) return 'remote'
  if (!Number.isFinite(input.size) || input.size < 0) return 'remote'
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS
  return input.size <= thresholds.docxFullRenderBytes ? 'local-full' : 'remote'
}

/**
 * Cheap pre-read size validation before a local file is read. DOCX automatic
 * thresholds choose a route; they do not reject the explicit local renderer.
 */
export function precheckLocalFile(input: {
  name: string
  size: number
  serverUrl?: string
  capabilities?: ServerCapabilities
}): void {
  if (!Number.isFinite(input.size) || input.size < 0) throw new FormatPolicyError('文件大小无效')
  if (input.size > FORMAT_POLICY.maxFileBytes) throw new FormatPolicyError('文件超过 1 GiB')
}

function serverSupports(capabilities: ServerCapabilities | undefined, format: DocFormat): boolean {
  const formats = capabilities?.formats
  // A server that predates capabilities (or omits the field) keeps legacy trust.
  return !formats || formats.length === 0 || formats.includes(format)
}

/** Decide local vs server and fail with a user-facing message when no route works. */
export function decideRoute(input: RouteInput): RouteDecision {
  if (!Number.isFinite(input.size) || input.size < 0) throw new FormatPolicyError('文件大小无效')
  const thresholds = thresholdsOf(input.capabilities)
  if (input.mode === 'server') {
    if (!input.serverUrl) throw new FormatPolicyError('没有配置解析服务地址（?server=http://…）')
    if (!serverSupports(input.capabilities, input.format))
      throw new FormatPolicyError(`解析服务不支持该格式：${input.format}`)
    return { mode: 'server', reason: 'manual server mode' }
  }
  if (input.size > FORMAT_POLICY.maxFileBytes) throw new FormatPolicyError('文件超过 1 GiB')
  if (input.mode === 'local') return { mode: 'local', reason: 'manual local mode' }
  if (!input.serverUrl) return { mode: 'local', reason: 'no server configured' }
  if (!serverSupports(input.capabilities, input.format))
    return { mode: 'local', reason: 'server does not advertise this format' }
  const threshold =
    input.format === 'docx' ? thresholds.docxAutoRemoteBytes : thresholds.pptxAutoRemoteBytes
  return input.size > threshold
    ? { mode: 'server', reason: 'auto: above local threshold' }
    : { mode: 'local', reason: 'auto: below local threshold' }
}
