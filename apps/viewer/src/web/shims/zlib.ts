// pako has no local type declarations; only the sync deflate helpers are used.
// @ts-expect-error pako ships without types in this repo
import { deflate, inflateRaw, ungzip } from 'pako'
import { BrowserBuffer, installBrowserBuffer } from '@genoffice/viewer-services/browser-buffer'

installBrowserBuffer()

function bytes(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new TextEncoder().encode(data)
}

export function deflateSync(data: Uint8Array | ArrayBuffer | string) {
  return BrowserBuffer.from(deflate(bytes(data)))
}

export function inflateRawSync(
  data: Uint8Array | ArrayBuffer,
  options?: { maxOutputLength?: number },
) {
  const out = inflateRaw(bytes(data))
  if (options?.maxOutputLength != null && out.length > options.maxOutputLength)
    throw new Error('Compressed data exceeds the size limit')
  return BrowserBuffer.from(out)
}

export function gunzipSync(data: Uint8Array | ArrayBuffer) {
  return BrowserBuffer.from(ungzip(bytes(data)))
}
