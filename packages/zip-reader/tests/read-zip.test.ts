import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { bufferSource, readZipEntries, readZipEntryMap } from '../src/index'

async function archive(files: Record<string, string | Uint8Array>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content, { compression: 'STORE' })
  }
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer
}

describe('readZipEntries', () => {
  it('lists entries and resolves their stored payload offsets', async () => {
    const bytes = await archive({ 'ppt/presentation.xml': '<p/>', 'ppt/media/image1.png': 'PNG' })
    const src = bufferSource(bytes)
    const entries = await readZipEntries(src)
    const names = entries
      .map((entry) => entry.name)
      .filter((name) => !name.endsWith('/'))
      .sort()
    expect(names).toEqual(['ppt/media/image1.png', 'ppt/presentation.xml'])

    for (const entry of entries.filter((item) => !item.name.endsWith('/'))) {
      const payload = await src.read(entry.dataOffset, entry.csize)
      expect(Buffer.from(payload).toString('utf8')).toBe(
        entry.name.endsWith('image1.png') ? 'PNG' : '<p/>',
      )
      expect(entry.usize).toBe(entry.csize) // stored entries
    }
  })

  it('keys entries by name in central-directory order', async () => {
    const bytes = await archive({ 'a.txt': 'a', 'b.txt': 'b' })
    const map = await readZipEntryMap(bufferSource(bytes))
    expect([...map.keys()]).toEqual(['a.txt', 'b.txt'])
  })

  it('rejects an archive whose declared sizes exceed the limits', async () => {
    const bytes = await archive({ 'big.bin': new Uint8Array(64) })
    await expect(
      readZipEntries(bufferSource(bytes), { maxParts: 100, maxPartBytes: 8, maxTotalBytes: 1024 }),
    ).rejects.toThrow(/declares 64 uncompressed bytes/)
  })

  it('rejects a truncated archive', async () => {
    const bytes = await archive({ 'a.txt': 'a' })
    await expect(readZipEntries(bufferSource(bytes.subarray(0, 10)))).rejects.toThrow(
      /end of central directory not found/,
    )
  })
})

describe('bufferSource', () => {
  it('reads subranges and refuses out-of-bounds reads', async () => {
    const src = bufferSource(new Uint8Array([1, 2, 3, 4]))
    expect([...(await src.read(1, 2))]).toEqual([2, 3])
    await expect(src.read(3, 2)).rejects.toThrow(/outside the archive/)
  })
})
