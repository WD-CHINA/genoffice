/**
 * Pure random-access zip reader.
 *
 * Reads the end-of-central-directory record, then the central directory, then
 * each entry's 30-byte local header. It never reads a payload, never inflates
 * and never imports Node builtins, so the same reader backs the Node parse
 * server and (later) a browser Worker. The declared-size gate from
 * `@genoffice/zip-gate` runs before any entry is copied.
 */

import {
  DEFAULT_ZIP_LIMITS,
  assertDeclaredSizesWithinLimits,
  type ZipLimits,
} from '@genoffice/zip-gate'

export { DEFAULT_ZIP_LIMITS, type ZipLimits } from '@genoffice/zip-gate'

/** Random-access byte source; `read` must return exactly `length` bytes or throw. */
export interface ByteSource {
  readonly size: number
  read(offset: number, length: number): Promise<Uint8Array>
}

export interface ZipEntry {
  name: string
  nameBytes: Uint8Array
  flags: number
  method: number
  time: number
  date: number
  crc: number
  csize: number
  usize: number
  verMade: number
  verNeed: number
  intAttr: number
  extAttr: number
  /** First byte of the (still compressed) payload inside the archive. */
  dataOffset: number
}

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_ZIP64_LOCATOR = 0x07064b50
const FLAG_ENCRYPTED = 0x1
const FLAG_UTF8 = 0x800

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function u16(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint16(offset, true)
}

function u32(bytes: Uint8Array, offset: number): number {
  return view(bytes).getUint32(offset, true)
}

/** In-memory source; useful for tests and for small archives. */
export function bufferSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      if (offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new Error('zip: read outside the archive')
      }
      return bytes.subarray(offset, offset + length)
    },
  }
}

async function readExact(src: ByteSource, offset: number, length: number): Promise<Uint8Array> {
  const bytes = await src.read(offset, length)
  if (bytes.length !== length) throw new Error('zip: short read')
  return bytes
}

/**
 * Parse the central directory and resolve every entry's payload offset.
 *
 * Throws for zip64, encrypted entries, corrupt directories and archives that
 * declare more parts/bytes than `limits` allows.
 */
export async function readZipEntries(
  src: ByteSource,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<ZipEntry[]> {
  const tailLen = Math.min(src.size, 22 + 0xffff)
  const tail = await readExact(src, src.size - tailLen, tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === SIG_EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found')
  if (eocd >= 20 && u32(tail, eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new Error('zip: zip64 archives are not supported')
  }
  const count = u16(tail, eocd + 10)
  const cdSize = u32(tail, eocd + 12)
  const cdOffset = u32(tail, eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('zip: zip64 archives are not supported')
  }
  if (cdOffset > src.size || cdSize > src.size || cdOffset + cdSize > src.size) {
    throw new Error('zip: corrupt central directory')
  }
  const cd = await readExact(src, cdOffset, cdSize)
  const entries: ZipEntry[] = []
  let pos = 0
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || u32(cd, pos) !== SIG_CENTRAL) {
      throw new Error('zip: corrupt central directory')
    }
    const flags = u16(cd, pos + 8)
    if (flags & FLAG_ENCRYPTED) throw new Error('zip: encrypted entries are not supported')
    const nameLen = u16(cd, pos + 28)
    const extraLen = u16(cd, pos + 30)
    const commentLen = u16(cd, pos + 32)
    if (pos + 46 + nameLen + extraLen + commentLen > cd.length) {
      throw new Error('zip: corrupt central directory')
    }
    const nameBytes = cd.subarray(pos + 46, pos + 46 + nameLen)
    const csize = u32(cd, pos + 20)
    const usize = u32(cd, pos + 24)
    const localOffset = u32(cd, pos + 42)
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('zip: zip64 archives are not supported')
    }
    entries.push({
      name: new TextDecoder(flags & FLAG_UTF8 ? 'utf-8' : 'latin1').decode(nameBytes),
      nameBytes,
      flags,
      method: u16(cd, pos + 10),
      time: u16(cd, pos + 12),
      date: u16(cd, pos + 14),
      crc: u32(cd, pos + 16),
      csize,
      usize,
      verMade: u16(cd, pos + 4),
      verNeed: u16(cd, pos + 6),
      intAttr: u16(cd, pos + 36),
      extAttr: u32(cd, pos + 38),
      dataOffset: localOffset,
    })
    pos += 46 + nameLen + extraLen + commentLen
  }

  // Same bounded-archive gate as the normal parse path, before any payload is
  // touched: a central directory may declare a tiny archive that inflates huge.
  assertDeclaredSizesWithinLimits(
    entries
      .filter((entry) => !entry.name.endsWith('/'))
      .map((entry) => ({
        name: entry.name,
        usize: entry.usize,
      })),
    limits,
  )

  // The local header's name/extra lengths can differ from the central copy.
  for (const entry of entries) {
    const local = await readExact(src, entry.dataOffset, 30)
    if (u32(local, 0) !== SIG_LOCAL) {
      throw new Error(`zip: corrupt local header for ${entry.name}`)
    }
    entry.dataOffset += 30 + u16(local, 26) + u16(local, 28)
    if (entry.dataOffset > src.size || entry.csize > src.size - entry.dataOffset) {
      throw new Error(
        `zip: entry ${entry.name} declares ${entry.csize} bytes at ${entry.dataOffset}, ` +
          `outside the ${src.size}-byte archive`,
      )
    }
  }
  return entries
}

/** Convenience: entries keyed by name, preserving central-directory order. */
export async function readZipEntryMap(
  src: ByteSource,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): Promise<Map<string, ZipEntry>> {
  const map = new Map<string, ZipEntry>()
  for (const entry of await readZipEntries(src, limits)) map.set(entry.name, entry)
  return map
}
