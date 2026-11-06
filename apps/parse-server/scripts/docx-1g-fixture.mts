import { open, readFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'

const args = process.argv.slice(2)
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}
const mb = Number(value('--mb', '1024'))
const output = value('--out', '/tmp/docx-1g-media.docx')
const template = new URL('../tests/fixtures/docx/font.docx', import.meta.url)
const bigName = 'word/media/big.bin'
const bigSize = mb * 1024 * 1024

const zip = await JSZip.loadAsync(await readFile(template))
const parts: Array<{ name: string; data?: Buffer; size?: number }> = []
for (const [name, entry] of Object.entries(zip.files)) {
  if (entry.dir) continue
  parts.push({ name, data: Buffer.from(await entry.async('uint8array')) })
}
parts.push({ name: bigName, size: bigSize })

const out = await open(output, 'w')
const central: Buffer[] = []
let offset = 0
const write = async (buffer: Buffer) => {
  await out.write(buffer, 0, buffer.length)
  offset += buffer.length
}
const u16 = (value: number) => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value)
  return b
}
const u32 = (value: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value)
  return b
}
const dosTime = 0
const dosDate = 0

for (const part of parts) {
  const name = Buffer.from(part.name)
  const localOffset = offset
  const size = part.size ?? part.data!.length
  let checksum = 0
  if (part.data) {
    checksum = crc32(part.data)
  } else {
    const zeros = Buffer.alloc(8 * 1024 * 1024)
    let remaining = size
    while (remaining > 0) {
      const chunk = remaining >= zeros.length ? zeros : zeros.subarray(0, remaining)
      checksum = crc32(chunk, checksum)
      remaining -= chunk.length
    }
  }
  const header = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(checksum),
    u32(size),
    u32(size),
    u16(name.length),
    u16(0),
  ])
  await write(header)
  await write(name)
  if (part.data) {
    await write(part.data)
  } else {
    const zeros = Buffer.alloc(8 * 1024 * 1024)
    let remaining = size
    while (remaining > 0) {
      const chunk = remaining >= zeros.length ? zeros : zeros.subarray(0, remaining)
      await write(chunk)
      remaining -= chunk.length
    }
  }
  central.push(
    Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(checksum),
      u32(size),
      u32(size),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      name,
    ]),
  )
}

const centralOffset = offset
for (const entry of central) await write(entry)
const centralSize = offset - centralOffset
await write(
  Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(parts.length),
    u16(parts.length),
    u32(centralSize),
    u32(centralOffset),
    u16(0),
  ]),
)
await out.close()
console.log('[docx-1g] wrote', { output, mb, bigSize })
