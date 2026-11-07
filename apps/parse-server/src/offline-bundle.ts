import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import { crc32, createInflateRaw } from 'node:zlib'
import { readZipEntries, type ZipEntry } from '@genoffice/zip-reader'
import type { OfflineBundleManifest, OfflineBundleResource } from '@genoffice/parse-contract'
import type { ArtifactWriter } from './artifact-store'
import { withFileSource } from './file-source'
import type { ServerLimits } from './limits'
import type { PptxLayoutInfo, PptxLayoutSlide } from './pptx-core'

export function validBundlePath(path: string): boolean {
  return (
    !!path &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every((segment) => !!segment && segment !== '.' && segment !== '..')
  )
}

export function externalMedia(unit: PptxLayoutSlide): string[] {
  const urls = [
    ...(unit.media ?? []).map(([, url]) => url),
    ...(unit.mediaRefs ?? []).map((ref) => ref.url),
  ]
  return urls.filter((url) => {
    if (url.startsWith('data:')) return false
    try {
      return new URL(url, 'http://artifact.invalid').origin !== 'http://artifact.invalid'
    } catch {
      return true
    }
  })
}

async function hashPart(path: string, entry: ZipEntry): Promise<{ size: number; sha256: string }> {
  if (entry.method !== 0 && entry.method !== 8)
    throw new Error('unsupported offline media compression')
  const input = entry.csize
    ? createReadStream(path, { start: entry.dataOffset, end: entry.dataOffset + entry.csize - 1 })
    : Readable.from([])
  const inflate = entry.method === 8 ? createInflateRaw() : undefined
  const fail = (error: Error) => {
    inflate?.destroy(error)
  }
  input.on('error', fail)
  const stream = inflate ? input.pipe(inflate) : input
  const hash = createHash('sha256')
  let size = 0
  let crc = 0
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer
      size += bytes.length
      if (size > entry.usize) throw new Error('offline media exceeds declared length')
      crc = crc32(bytes, crc)
      hash.update(bytes)
    }
    if (size !== entry.usize || crc !== entry.crc)
      throw new Error('offline media length or CRC mismatch')
    return { size, sha256: hash.digest('hex') }
  } finally {
    input.destroy()
    inflate?.destroy()
    input.removeListener('error', fail)
  }
}

/** Authoritative complete inventory of stripped package media, not URL recursion. */
export async function writeOfflineBundle(
  writer: ArtifactWriter,
  input: {
    path: string
    fileId: string
    artifactKey: string
    modelArtifactKey: string
    modelSchemaVersion: number
    parserVersion: string
    parserFingerprint: string
    limits: ServerLimits
  },
  layout: PptxLayoutInfo,
  externalResources: Set<string>,
  describeModel: (id: string) => { size: number; sha256: string },
): Promise<void> {
  const resources: OfflineBundleResource[] = []
  const fonts = layout.fonts.map((font) => ({
    id: font.id,
    family: font.family,
    bold: font.bold,
    italic: font.italic,
    also: [...font.also],
  }))
  await writer.append('bundle:layout', {
    size: { ...layout.size },
    slideCount: layout.slideCount,
    parserVersion: layout.parserVersion,
    fonts,
  })
  const record = (path: string, id: string) =>
    resources.push({ path, ...(id === 'bundle:layout' ? writer.describe(id) : describeModel(id)) })
  record('layout.json', 'bundle:layout')
  for (let index = 0; index < layout.slideCount; index++)
    record(`layout/${index}.json`, `unit:${index}`)
  for (const [index, font] of layout.fonts.entries()) {
    if (!validBundlePath(font.id) || font.id.includes('/'))
      throw new Error('invalid bundle font identity')
    record(`fonts/font-${index}.sfnt`, `font:${font.id}`)
  }
  const parts = await withFileSource(input.path, (source) =>
    readZipEntries(source, {
      maxParts: input.limits.maxParts,
      maxPartBytes: input.limits.maxPartBytes,
      maxTotalBytes: input.limits.maxTotalUncompressedBytes,
    }),
  )
  for (const entry of parts) {
    if (!entry.name.startsWith('ppt/media/') || entry.name.endsWith('/')) continue
    if (!validBundlePath(entry.name)) throw new Error('invalid bundle media path')
    const resource = { path: `parts/${entry.name}`, ...(await hashPart(input.path, entry)) }
    await writer.append(`bundle:part:${entry.name}`, resource)
    resources.push(resource)
  }
  const totalBytes = resources.reduce((sum, item) => sum + item.size, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new Error('offline bundle size overflow')
  const manifest = {
    bundleSchemaVersion: 1,
    modelSchemaVersion: input.modelSchemaVersion,
    artifactKey: input.artifactKey,
    modelArtifactKey: input.modelArtifactKey,
    fileId: input.fileId,
    format: 'pptx',
    parserVersion: input.parserVersion,
    parserFingerprint: input.parserFingerprint,
    unitCount: layout.slideCount,
    fonts: fonts.map((font, index) => ({ ...font, resourcePath: `fonts/font-${index}.sfnt` })),
    inventory: 'ppt-media-v1',
    totalBytes,
    resources: resources.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    externalResources: [...externalResources].sort(),
  } satisfies OfflineBundleManifest
  await writer.append('bundle', manifest)
}
