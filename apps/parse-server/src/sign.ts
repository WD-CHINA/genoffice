import { createHmac, timingSafeEqual } from 'node:crypto'

/** HMAC-signed resource URL query. `resource` is 'content' or a part path. */
export interface SignedResource {
  exp: number
  sig: string
}

function signature(secret: string, fileId: string, resource: string, exp: number): string {
  return createHmac('sha256', secret).update(`${fileId}\n${resource}\n${exp}`).digest('base64url')
}

export function signResource(
  secret: string,
  fileId: string,
  resource: string,
  ttlSeconds = 60 * 60,
): SignedResource {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  return { exp, sig: signature(secret, fileId, resource, exp) }
}

export function verifyResource(
  secret: string,
  fileId: string,
  resource: string,
  exp: number,
  sig: string,
): boolean {
  if (!Number.isSafeInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false
  const expected = Buffer.from(signature(secret, fileId, resource, exp))
  const given = Buffer.from(sig)
  return expected.length === given.length && timingSafeEqual(expected, given)
}
