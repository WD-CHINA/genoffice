/**
 * Read a fetch response body while counting bytes, so an oversized download is
 * rejected before the whole file is buffered (plan §8.1 item 2).
 *
 * Content-Length is only a hint: the declared value is checked first, then the
 * streamed byte count is enforced for chunked/lying responses.
 */
export class DownloadLimitError extends Error {
  constructor(limit: number) {
    super(`文件超过 ${Math.floor(limit / (1024 * 1024))} MiB`)
    this.name = 'DownloadLimitError'
  }
}

export async function readResponseLimited(
  response: Response,
  limitBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0)
    throw new Error('invalid download limit')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limitBytes) throw new DownloadLimitError(limitBytes)
  const body = response.body
  if (!body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > limitBytes) throw new DownloadLimitError(limitBytes)
    return bytes
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > limitBytes) {
        await reader.cancel().catch(() => undefined)
        throw new DownloadLimitError(limitBytes)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
