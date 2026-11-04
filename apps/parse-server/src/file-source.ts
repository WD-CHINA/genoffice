import { open } from 'node:fs/promises'
import type { ByteSource } from '@genoffice/zip-reader'

/** Open a file as a random-access ByteSource; the handle is closed when `fn` settles. */
export async function withFileSource<T>(
  path: string,
  fn: (source: ByteSource) => Promise<T>,
): Promise<T> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const source: ByteSource = {
      size,
      async read(offset, length) {
        const buffer = Buffer.alloc(length)
        let done = 0
        while (done < length) {
          const { bytesRead } = await handle.read(buffer, done, length - done, offset + done)
          if (bytesRead === 0) throw new Error('file: unexpected end of file')
          done += bytesRead
        }
        return buffer
      },
    }
    return await fn(source)
  } finally {
    await handle.close()
  }
}
