import { signResource } from './sign'

/** Rebase and sign internal DOCX resources without mutating persisted chunks. */
export function refreshDocxResourceUrls(
  value: unknown,
  fileId: string,
  baseUrl: string,
  secret?: string,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => refreshDocxResourceUrls(item, fileId, baseUrl, secret))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        refreshDocxResourceUrls(item, fileId, baseUrl, secret),
      ]),
    )
  }
  if (typeof value !== 'string') return value
  const marker = `/v1/files/${encodeURIComponent(fileId)}/parts/`
  let parsed: URL
  try {
    parsed = new URL(value, baseUrl)
  } catch {
    return value
  }
  if (!parsed.pathname.startsWith(marker)) return value
  let part: string
  try {
    part = parsed.pathname.slice(marker.length).split('/').map(decodeURIComponent).join('/')
  } catch {
    return value
  }
  const path = part.split('/').map(encodeURIComponent).join('/')
  const url = `${baseUrl.replace(/\/+$/, '')}${marker}${path}`
  if (!secret) return url
  const { exp, sig } = signResource(secret, fileId, part)
  return `${url}?exp=${exp}&sig=${sig}`
}
