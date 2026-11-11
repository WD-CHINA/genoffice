import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalJson, type ArtifactReader } from './artifact-store'

/** Structural reader surface shared by local readers and catalog read handles. */
type ArtifactExportReader = Pick<ArtifactReader, 'has' | 'read' | 'manifest'>

/**
 * Materialize one artifact generation into the canonical directory layout the
 * plan §4.2 describes: `document.json`, `units/<index>.json`,
 * `fonts/<font-id>.sfnt`, `external-media.json` and the packed
 * `artifact-manifest.json`. The packed `units.bin` stays the runtime truth;
 * this export is for inspection, portability and backup tooling.
 */
export interface ArtifactExportResult {
  documentBytes: number
  units: number
  fonts: number
  externalMedia: number
  totalBytes: number
}

function safeFontName(index: number, id: string): string {
  const base = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'font'
  return `${String(index).padStart(3, '0')}-${base}.sfnt`
}

export async function exportArtifactDirectory(
  reader: ArtifactExportReader,
  outputDir: string,
  options: { reserve?: (bytes: number) => Promise<void> } = {},
): Promise<ArtifactExportResult> {
  let totalBytes = 0
  const write = async (path: string, body: string | Uint8Array): Promise<void> => {
    const bytes = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
    await options.reserve?.(bytes)
    await writeFile(path, body)
    totalBytes += bytes
  }
  if (!reader.has('document')) throw new Error('artifact has no document record')
  const document = await reader.read('document')
  await mkdir(join(outputDir, 'units'), { recursive: true })
  await mkdir(join(outputDir, 'fonts'), { recursive: true })
  const documentJson = canonicalJson(document)
  await write(join(outputDir, 'document.json'), documentJson + '\n')
  await write(join(outputDir, 'artifact-manifest.json'), canonicalJson(reader.manifest) + '\n')
  const model = (document as { model?: { unitCount?: unknown } }).model
  const unitCount = Number(model?.unitCount ?? 0)
  if (!Number.isSafeInteger(unitCount) || unitCount < 0)
    throw new Error('invalid artifact unit count')
  for (let index = 0; index < unitCount; index++) {
    const id = `unit:${index}`
    if (!reader.has(id)) throw new Error(`artifact is missing ${id}`)
    await write(join(outputDir, 'units', `${index}.json`),
      canonicalJson(await reader.read(id)) + '\n')
  }
  const fonts = (document as { fonts?: Array<{ id?: unknown }> }).fonts ?? []
  let fontFiles = 0
  for (const [index, font] of fonts.entries()) {
    if (typeof font?.id !== 'string' || !font.id) continue
    const id = `font:${font.id}`
    if (!reader.has(id)) continue
    const bytes = await reader.read(id)
    if (!(bytes instanceof Uint8Array)) continue
    await write(join(outputDir, 'fonts', safeFontName(index, font.id)), bytes)
    fontFiles++
  }
  let externalMedia = 0
  if (reader.has('external-media')) {
    const value = await reader.read('external-media')
    const urls = Array.isArray(value) ? value : []
    externalMedia = urls.length
    await write(join(outputDir, 'external-media.json'), canonicalJson(value) + '\n')
  }
  return { documentBytes: Buffer.byteLength(documentJson), units: unitCount,
    fonts: fontFiles, externalMedia, totalBytes }
}
