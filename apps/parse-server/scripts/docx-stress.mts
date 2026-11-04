import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

const args = process.argv.slice(2)
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}
const url = value('--url', 'http://127.0.0.1:8787')
const blocks = Number(value('--blocks', '20000'))
const inputFile = value('--file', '')
const template = 'apps/viewer/src/web/public/docx-spike-behavior.docx'

let bytes: Uint8Array
if (inputFile) {
  bytes = await readFile(inputFile)
} else {
  const zip = await JSZip.loadAsync(await readFile(template))
  const xml = await zip.file('word/document.xml')!.async('string')
  const start = xml.indexOf('<w:body>') + '<w:body>'.length
  const end = xml.lastIndexOf('</w:body>')
  const body = xml.slice(start, end)
  const sect = /<w:sectPr[\s\S]*?<\/w:sectPr>/.exec(body)?.[0] ?? ''
  const paragraphs: string[] = []
  for (let index = 0; index < blocks; index++) {
    paragraphs.push(
      `<w:p><w:r><w:t xml:space="preserve">DOCX stress paragraph ${index} lorem ipsum dolor sit amet consectetur adipiscing elit.</w:t></w:r></w:p>`,
    )
  }
  zip.file('word/document.xml', xml.slice(0, start) + paragraphs.join('') + sect + xml.slice(end))
  bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
console.log('[docx-stress] generated', {
  blocks: inputFile ? 'file' : blocks,
  compressedBytes: bytes.length,
})

const health = async () => (await (await fetch(`${url}/v1/health`)).json()) as any
const before = await health()
const uploadStarted = performance.now()
const uploaded = await fetch(`${url}/v1/files`, {
  method: 'POST',
  body: Buffer.from(bytes),
  headers: { 'Content-Type': 'application/octet-stream' },
})
const uploadMs = performance.now() - uploadStarted
const file = (await uploaded.json()) as { fileId: string; size: number }
console.log('[docx-stress] upload', {
  status: uploaded.status,
  uploadMs: Math.round(uploadMs),
  size: file.size,
})

const openStarted = performance.now()
const opened = await fetch(`${url}/v1/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ fileId: file.fileId }),
})
const openMs = performance.now() - openStarted
const session = (await opened.json()) as { sessionId: string; model: { unitCount?: number } }
const after = await health()
console.log('[docx-stress] session', {
  status: opened.status,
  openMs: Math.round(openMs),
  unitCount: session.model?.unitCount,
  healthBefore: before,
  healthAfter: after,
})
if (opened.status === 201) {
  const unit = await fetch(`${url}/v1/sessions/${session.sessionId}/units/0`)
  console.log('[docx-stress] unit0', unit.status, (await unit.json())?.blocks?.length)
  await fetch(`${url}/v1/sessions/${session.sessionId}`, { method: 'DELETE' })
}
console.log('[docx-stress] done')
