import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'
import {
  bufferSource,
  readZipEntries,
  openZipFile,
  slimDocx,
  type ZipFile,
} from '@genoffice/docx-engine/zip-splice'
import { isLazyMediaPart } from '@genoffice/docx-engine/lazy-media'

/** The original slimDocx placeholders and ZIP entry reader, scoped to one session. */
export async function prepareDocMedia(path: string, plain?: Buffer) {
  const zip: ZipFile = plain
    ? {
        ...bufferSource(plain),
        entries: new Map(
          (await readZipEntries(bufferSource(plain))).map((entry) => [entry.name, entry]),
        ),
        close: async () => {},
      }
    : await openZipFile(path)
  try {
    const eligible = [...zip.entries.values()].filter((entry) => isLazyMediaPart(entry.name))
    if (eligible.reduce((sum, entry) => sum + entry.usize, 0) < 1024 * 1024) {
      await zip.close()
      return null
    }
    const hash = createHash('sha256')
      .update(plain || (await readFile(path)))
      .digest('hex')
    const slim = await slimDocx(zip, hash, 1024 * 1024)
    if (!slim) {
      await zip.close()
      return null
    }
    return {
      bytes: slim.bytes,
      async media(requestHash: string, part: string) {
        if (requestHash !== hash || !isLazyMediaPart(part)) return null
        const entry = zip.entries.get(part)
        if (!entry || entry.usize > 64 * 1024 * 1024) return null
        const compressed = await zip.read(entry.dataOffset, entry.csize)
        const bytes =
          entry.method === 0
            ? compressed
            : entry.method === 8
              ? inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 })
              : null
        if (!bytes || bytes.length !== entry.usize) return null
        const ext = part.split('.').pop()?.toLowerCase() || ''
        const mime: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          bmp: 'image/bmp',
          webp: 'image/webp',
          svg: 'image/svg+xml',
        }
        return { bytes, mime: mime[ext] || 'application/octet-stream' }
      },
      async close() {
        slim.bytes.fill(0)
        await zip.close()
      },
    }
  } catch (error) {
    await zip.close()
    throw error
  }
}
