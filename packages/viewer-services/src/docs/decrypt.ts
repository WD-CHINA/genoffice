/**
 * Password-protected (ECMA-376 encrypted) docx support. The single integration
 * point for the third-party crypto implementation (officecrypto-tool): if it
 * ever needs replacing, only this module changes.
 *
 * An encrypted docx is not a zip: Word/WPS repackage it as a CFB (OLE2)
 * container holding an EncryptionInfo stream (parameters) and an
 * EncryptedPackage stream (the ciphertext of the real docx zip). Both apps
 * write the same MS-OFFCRYPTO formats (Standard = AES-128/SHA-1, Agile =
 * AES-256/SHA-512), and both open either — so we decrypt both and re-encrypt
 * with Agile, matching Word 2013+ defaults.
 */
import '../browser-buffer'
import officeCrypto from 'officecrypto-tool'

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

function contains(bytes: Uint8Array, needle: Uint8Array): boolean {
  if (typeof (bytes as Buffer).includes === 'function')
    return (bytes as Buffer).includes(Buffer.from(needle))
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

/** CFB (OLE2) container magic — for a .docx path this means "encrypted" (plain docx is a zip) */
export function isCfbFile(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && CFB_MAGIC.every((byte, index) => bytes[index] === byte)
}

/** ECMA-376 encrypted OOXML: CFB magic + an EncryptedPackage stream in the directory. */
export function isEncryptedDocx(bytes: Uint8Array): boolean {
  return isCfbFile(bytes) && contains(bytes, ENCRYPTED_STREAM_UTF16)
}

export type DecryptFailReason = 'wrong-password' | 'unsupported'

export class DocxDecryptError extends Error {
  readonly reason: DecryptFailReason
  constructor(reason: DecryptFailReason, message: string) {
    super(message)
    this.reason = reason
  }
}

/**
 * Decrypt an encrypted docx into plain zip bytes. Throws DocxDecryptError with
 * reason 'wrong-password' (verifier mismatch — reprompt) or 'unsupported'
 * (exotic scheme, e.g. WPS account encryption or Extensible encryption).
 */
export async function decryptDocx(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  try {
    const plain = await officeCrypto.decrypt(Buffer.from(bytes), { password })
    return plain instanceof Uint8Array ? plain : Buffer.from(plain)
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (message.includes('password is incorrect')) {
      throw new DocxDecryptError('wrong-password', message)
    }
    throw new DocxDecryptError('unsupported', message)
  }
}

