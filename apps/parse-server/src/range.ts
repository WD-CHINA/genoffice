/** Parse a single HTTP byte range; null means no Range header, 'invalid' means 416. */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return 'invalid'
  if (size <= 0 || start < 0 || start >= size || start > end) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}
