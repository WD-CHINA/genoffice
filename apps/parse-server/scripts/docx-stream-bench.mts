import { Readable } from 'node:stream'
import { streamDocxBlocks } from '../src/docx-stream'

const blocks = Number(process.argv[2] || 100_000)
const text = 'streaming docx block benchmark '.repeat(4)
const paragraphs: string[] = []
for (let index = 0; index < blocks; index++) {
  paragraphs.push(`<w:p><w:r><w:t>${index} ${text}</w:t></w:r></w:p>`)
}
const xml = `<w:document><w:body>${paragraphs.join('')}</w:body></w:document>`
const bytes = new TextEncoder().encode(xml)
const chunks: Uint8Array[] = []
const chunkSize = 64 * 1024
for (let offset = 0; offset < bytes.length; offset += chunkSize) {
  chunks.push(bytes.subarray(offset, offset + chunkSize))
}
const before = process.memoryUsage()
const started = performance.now()
let count = 0
for await (const _block of streamDocxBlocks(Readable.from(chunks))) count++
const elapsed = (performance.now() - started) / 1000
const after = process.memoryUsage()
console.log(
  JSON.stringify({
    blocks: count,
    xmlMiB: +(bytes.length / 1024 ** 2).toFixed(2),
    seconds: +elapsed.toFixed(3),
    blocksPerSecond: Math.round(count / elapsed),
    rssDeltaMiB: +((after.rss - before.rss) / 1024 ** 2).toFixed(1),
    heapDeltaMiB: +((after.heapUsed - before.heapUsed) / 1024 ** 2).toFixed(1),
  }),
)
