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
import officeCrypto from 'officecrypto-tool'

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

/** CFB (OLE2) container magic — for a .docx path this means "encrypted" (plain docx is a zip) */
export function isCfbFile(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(CFB_MAGIC)
}

/** ECMA-376 encrypted OOXML: CFB magic + an EncryptedPackage stream in the directory. */
export function isEncryptedDocx(bytes: Buffer): boolean {
  return isCfbFile(bytes) && bytes.includes(ENCRYPTED_STREAM_UTF16)
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
export async function decryptDocx(bytes: Buffer, password: string): Promise<Buffer> {
  try {
    return await officeCrypto.decrypt(bytes, { password })
  } catch (err) {
    const message = String((err as Error)?.message ?? err)
    if (message.includes('password is incorrect')) {
      throw new DocxDecryptError('wrong-password', message)
    }
    throw new DocxDecryptError('unsupported', message)
  }
}

