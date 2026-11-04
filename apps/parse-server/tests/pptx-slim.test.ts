import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS } from '../src/limits'
import { readFilePart } from '../src/parts'
import { slimPptxFile } from '../src/pptx-slim'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function makeDeck(mediaBytes: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pptx-slim-'))
  dirs.push(dir)
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', '<p:presentation/>')
  zip.file('ppt/media/image1.png', Buffer.alloc(mediaBytes, 7), { compression: 'STORE' })
  const path = join(dir, 'deck.pptx')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  return path
}

describe('pptx slim archive', () => {
  it('leaves media on disk and keeps the parser input small', async () => {
    const mediaBytes = 8 * 1024 * 1024
    const path = await makeDeck(mediaBytes)
    const slim = await slimPptxFile(path, DEFAULT_LIMITS)
    expect(slim.mediaParts.has('ppt/media/image1.png')).toBe(true)
    expect(slim.removedBytes).toBe(mediaBytes)
    expect(slim.bytes.length).toBeLessThan(1024 * 1024)
    expect(slim.bytes.includes(Buffer.from('ppt/media/image1.png'))).toBe(false)

    const part = await readFilePart(path, 'ppt/media/image1.png', DEFAULT_LIMITS)
    expect(part && 'bytes' in part ? part.mime : null).toBe('image/png')
    expect(part && 'bytes' in part ? part.bytes.length : 0).toBe(mediaBytes)

    const sliced = await readFilePart(path, 'ppt/media/image1.png', DEFAULT_LIMITS, 'bytes=0-3')
    expect(sliced && 'bytes' in sliced ? sliced.ranged : false).toBe(true)
    expect(sliced && 'bytes' in sliced ? sliced.bytes.length : 0).toBe(4)
    expect(sliced && 'range' in sliced ? sliced.range : null).toEqual({ start: 0, end: 3 })
  })

  it('rejects a slim archive over the parser budget', async () => {
    const path = await makeDeck(0)
    await expect(slimPptxFile(path, { ...DEFAULT_LIMITS, maxParseBytes: 8 })).rejects.toMatchObject(
      { code: 'parse_limit' },
    )
  })
})
