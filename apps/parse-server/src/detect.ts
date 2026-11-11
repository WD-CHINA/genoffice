import { open } from 'node:fs/promises'
import { readZipEntries, type ByteSource } from '@genoffice/zip-reader'
import type { DocFormat } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'

/** Formats the sniffer can name; anything else returns null and the server rejects it. */
export type DetectedFormat = DocFormat | 'xlsx' | 'encrypted'

function fileSource(handle: Awaited<ReturnType<typeof open>>, size: number): ByteSource {
  return {
    size,
    async read(offset, length) {
      const buffer = Buffer.alloc(length)
      let done = 0
      while (done < length) {
        const { bytesRead } = await handle.read(buffer, done, length - done, offset + done)
        if (bytesRead === 0) throw new Error('detect: unexpected end of file')
        done += bytesRead
      }
      return buffer
    },
  }
}

/**
 * Name a container from its first bytes: PDF magic, or a zip whose entries
 * identify PPTX/DOCX/XLSX. The zip directory read is also the first gate on
 * the archive, so a declared bomb is rejected before any parse starts.
 */
export async function detectFormat(
  path: string,
  limits: ServerLimits,
): Promise<DetectedFormat | null> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const head = Buffer.alloc(Math.min(size, 1024))
    await handle.read(head, 0, head.length, 0)
    if (head.includes(Buffer.from('%PDF-'))) return 'pdf'
    // OOXML files opened with a password are OLE compound files (CFB), not
    // zip packages. Report them explicitly: the parser has no decryption path
    // and must never treat the binary container as an unknown/corrupt zip.
    if (
      head.length >= 8 &&
      head[0] === 0xd0 &&
      head[1] === 0xcf &&
      head[2] === 0x11 &&
      head[3] === 0xe0 &&
      head[4] === 0xa1 &&
      head[5] === 0xb1 &&
      head[6] === 0x1a &&
      head[7] === 0xe1
    ) return 'encrypted'
    if (
      head.length >= 4 &&
      head[0] === 0x50 &&
      head[1] === 0x4b &&
      head[2] === 0x03 &&
      head[3] === 0x04
    ) {
      const source = fileSource(handle, size)
      let names: Set<string>
      try {
        names = new Set(
          (
            await readZipEntries(source, {
              maxParts: limits.maxParts,
              maxPartBytes: limits.maxPartBytes,
              maxTotalBytes: limits.maxTotalUncompressedBytes,
            })
          ).map((entry) => entry.name),
        )
      } catch {
        return null
      }
      if (names.has('ppt/presentation.xml')) return 'pptx'
      if (names.has('word/document.xml')) return 'docx'
      if (names.has('xl/workbook.xml')) return 'xlsx'
      return null
    }
    return null
  } finally {
    await handle.close()
  }
}
