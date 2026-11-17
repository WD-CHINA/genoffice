/** Main-package OOXML implementation; this adapter only normalizes browser bytes. */
import '../browser-buffer'
import {
  isCfbFile as originalIsCfbFile,
  isEncryptedOoxml,
  decryptOoxml,
} from '../shared/ooxml-encryption'
export { OoxmlDecryptError as DocxDecryptError } from '../shared/ooxml-encryption'
export type { OoxmlDecryptFailReason as DecryptFailReason } from '../shared/ooxml-encryption'

export function isCfbFile(bytes: Uint8Array): boolean {
  return originalIsCfbFile(Buffer.from(bytes.subarray(0, 8)))
}
export function isEncryptedDocx(bytes: Uint8Array): boolean {
  // Plain large ZIP documents need only the original eight-byte magic check.
  return isCfbFile(bytes) && isEncryptedOoxml(Buffer.from(bytes))
}
export async function decryptDocx(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  // The browser's compatibility Buffer.isBuffer also accepts plain Uint8Array;
  // explicitly normalize so the original module can rely on equals/includes.
  return decryptOoxml(Buffer.from(bytes), password)
}
