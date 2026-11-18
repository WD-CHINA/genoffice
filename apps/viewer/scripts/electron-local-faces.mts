/** Map CSS local() names to the actual host SFNT face, retaining the source descriptors. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { extractFace } from '../../../packages/viewer-services/src/slides/main/fonts'

type Face = {
  path: string
  offset: number
  names: string[]
  family: string[]
  bold: boolean
  italic: boolean
}
const faces: Face[] = []
function scan(dir: string) {
  let items
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const path = join(dir, item.name)
    if (item.isDirectory()) {
      scan(path)
      continue
    }
    if (!/\.(ttf|otf|ttc|otc)$/i.test(path)) continue
    try {
      const data = readFileSync(path),
        offsets =
          data.toString('ascii', 0, 4) === 'ttcf'
            ? Array.from({ length: data.readUInt32BE(8) }, (_, i) => data.readUInt32BE(12 + i * 4))
            : [0]
      for (const offset of offsets) {
        let name = 0,
          os2 = 0,
          post = 0
        for (let i = 0; i < data.readUInt16BE(offset + 4); i++) {
          const p = offset + 12 + i * 16,
            tag = data.toString('ascii', p, p + 4),
            at = data.readUInt32BE(p + 8)
          if (tag === 'name') name = at
          if (tag === 'OS/2') os2 = at
          if (tag === 'post') post = at
        }
        if (!name) continue
        const names: string[] = [],
          family: string[] = [],
          strings = name + data.readUInt16BE(name + 4)
        for (let i = 0; i < data.readUInt16BE(name + 2); i++) {
          const p = name + 6 + i * 12,
            platform = data.readUInt16BE(p),
            id = data.readUInt16BE(p + 6),
            length = data.readUInt16BE(p + 8),
            at = strings + data.readUInt16BE(p + 10)
          if (![1, 4, 6, 16].includes(id) || at + length > data.length) continue
          const value =
            platform === 0 || platform === 3
              ? Buffer.from(data.subarray(at, at + length))
                  .swap16()
                  .toString('utf16le')
              : platform === 1 && data.readUInt16BE(p + 2) === 0
                ? data.toString('latin1', at, at + length)
                : ''
          if (!value) continue
          ;(id === 1 || id === 16 ? family : names).push(value.toLowerCase())
        }
        faces.push({
          path,
          offset,
          names,
          family,
          bold: !!os2 && data.readUInt16BE(os2 + 4) >= 600,
          italic: !!post && data.readInt32BE(post + 4) !== 0,
        })
      }
    } catch {
      /* Invalid host font files do not become a fabricated local() match. */
    }
  }
}
let scanned = false
export function localFaceResource(
  names: string[],
  bold = false,
  italic = false,
  allowFamily = false,
) {
  if (!scanned) {
    scanned = true
    for (const dir of ['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')])
      scan(dir)
  }
  for (const name of names) {
    const found = faces
      .filter(
        (face) =>
          face.names.includes(name.toLowerCase()) ||
          (allowFamily && face.family.includes(name.toLowerCase())),
      )
      .sort(
        (a, b) =>
          Number(a.bold !== bold) +
          Number(a.italic !== italic) -
          Number(b.bold !== bold) -
          Number(b.italic !== italic),
      )[0]
    if (found)
      return {
        bold: found.bold,
        italic: found.italic,
        bytes: () => extractFace(readFileSync(found.path), found.offset),
      }
  }
}
