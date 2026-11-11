/**
 * Refresh one signed part URL after a 403/expired signature or deployment-domain
 * change, without reopening the reading session. Requires a bearer token; the
 * server re-signs the same part path with the current secret.
 */
const PART_URL = /^https?:\/\/[^/]+\/v1\/files\/([a-f0-9]{64})\/parts\/(.+)$/

export async function refreshSignedPartUrl(
  url: string,
  options: {
    server: string
    token?: string
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<string | null> {
  const match = PART_URL.exec(url.split('?')[0]!)
  if (!match) return null
  const fileId = match[1]!
  let path: string
  try {
    path = match[2]!.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const response = await fetchImpl(
    options.server.replace(/\/+$/, '') + '/v1/files/' + encodeURIComponent(fileId) + '/part-url',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
      },
      body: JSON.stringify({ path }),
      signal: options.signal,
    },
  )
  if (!response.ok) return null
  const body = await response.json() as { url?: unknown }
  return typeof body?.url === 'string' && body.url.length > 0 ? body.url : null
}
