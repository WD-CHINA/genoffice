import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createParseServer, type ParseServer } from '../src/server'
import { openDocxDocumentStream } from '../src/docx-stream'
import { resolveLimits } from '../src/limits'
import { writeChunks } from '../src/docx-chunks'
import { writeStoredZip } from '../src/zip-write'

const directories: string[] = []
const servers: ParseServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'docx-stream-storage-'))
  directories.push(dir)
  return dir
}

it('parses a real body larger than the auxiliary archive budget into persistent chunks', async () => {
  const dir = await directory()
  const zip = await JSZip.loadAsync(
    await readFile(join(process.cwd(), 'tests/fixtures/docx/table.docx')),
  )
  const count = 1201
  const text = '正文内容 '.repeat(180).trimEnd()
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      Array.from(
        { length: count },
        (_, index) => `<w:p><w:r><w:t>${index}:${text}</w:t></w:r></w:p>`,
      ).join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
  )
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const server = await createParseServer({ dataDir: dir, limits: { maxParseBytes: 16 * 1024 } })
  servers.push(server)
  const uploaded = await fetch(server.url + '/v1/files', { method: 'POST', body: bytes })
  expect(uploaded.status).toBe(201)
  const { fileId } = (await uploaded.json()) as { fileId: string }
  const response = await fetch(server.url + '/v1/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  expect(response.status, await response.clone().text()).toBe(201)
  const opened = (await response.json()) as { sessionId: string; model: { unitCount: number } }
  expect(opened.model.unitCount).toBe(7)
  let paragraphs = 0
  for (let index = 0; index < opened.model.unitCount; index++) {
    const unit = (await (
      await fetch(`${server.url}/v1/sessions/${opened.sessionId}/units/${index}`)
    ).json()) as { blocks: any[] }
    for (const block of unit.blocks) {
      const value = (block.runs ?? []).map((run: { text: string }) => run.text ?? '').join('')
      if (!value) continue
      expect(value).toBe(`${paragraphs}:${text}`)
      paragraphs++
    }
  }
  expect(paragraphs).toBe(count)
  expect(await readdir(join(dir, 'chunks'))).toEqual([])
})

it('consumes chunk batches lazily and waits for each reservation before pulling another', async () => {
  const dir = await directory()
  let produced = 0
  let admitted = 0
  async function* batches() {
    for (let index = 0; index < 4; index++) {
      expect(produced).toBe(admitted)
      produced++
      yield [{ index }]
    }
  }
  const entries = await writeChunks(dir, batches(), async () => {
    expect(produced).toBe(admitted + 1)
    admitted++
  })
  expect(entries).toHaveLength(4)
  expect(admitted).toBe(4)
})

it('rejects a corrupted stored document stream using its ZIP CRC', async () => {
  const dir = await directory()
  const path = join(dir, 'bad.docx')
  const bytes = writeStoredZip([{ name: 'word/document.xml', data: Buffer.from('<w:document/>') }])
  const offset = bytes.indexOf(Buffer.from('<w:document/>'))
  bytes[offset + 3] ^= 1
  await writeFile(path, bytes)
  const stream = await openDocxDocumentStream(path, resolveLimits())
  await expect(
    (async () => {
      for await (const _chunk of stream) {
        /* consume */
      }
    })(),
  ).rejects.toThrow('CRC mismatch')
})
