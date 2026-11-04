/**
 * Stability smoke test:
 *  1. build a PPTX whose bulk is one huge stored media part (default 1 GiB)
 *  2. upload it and open several sessions concurrently
 *  3. open a session on a 1 ms-timeout server and verify 504 + healthy server
 *
 * Run: node --import tsx scripts/stress-smoke.mts --url http://127.0.0.1:8787 --size 1G
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { request } from 'node:http'
import { crc32 } from 'node:zlib'
import JSZip from 'jszip'
import { createBlankPptx } from '@genoffice/pptx-engine'
import { createParseServer } from '../src/server'

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

function parseSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)$/i.exec(value.trim())
  if (!match) throw new Error(`invalid size: ${value}`)
  const units: Record<string, number> = {
    '': 1,
    b: 1,
    k: 1024,
    kb: 1024,
    m: 1024 ** 2,
    mb: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1024 ** 3,
  }
  return Math.round(Number(match[1]) * (units[match[2].toLowerCase()] ?? 1))
}

function localHeader(name: Buffer, size: number, crc: number): Buffer {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0x800, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt32LE(crc >>> 0, 14)
  header.writeUInt32LE(size, 18)
  header.writeUInt32LE(size, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return header
}

function centralHeader(name: Buffer, size: number, crc: number, offset: number): Buffer {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(0x02014b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(20, 6)
  header.writeUInt16LE(0x800, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(0, 12)
  header.writeUInt16LE(0, 14)
  header.writeUInt32LE(crc >>> 0, 16)
  header.writeUInt32LE(size, 20)
  header.writeUInt32LE(size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(0, 38)
  header.writeUInt32LE(offset, 42)
  return header
}

async function writeLargeDeck(path: string, mediaBytes: number): Promise<void> {
  const zip = await JSZip.loadAsync(await createBlankPptx())
  const parts: Array<{ name: string; data: Uint8Array }> = []
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue
    let data = await entry.async('uint8array')
    if (name === 'ppt/slides/slide1.xml') {
      const xml = decoder.decode(data)
      const pic =
        '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Huge"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>' +
        '<p:blipFill><a:blip r:embed="rId99"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
        '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/></a:xfrm>' +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>'
      data = encoder.encode(xml.replace('</p:spTree>', `${pic}</p:spTree>`))
    } else if (name === 'ppt/slides/_rels/slide1.xml.rels') {
      const xml = decoder.decode(data)
      data = encoder.encode(
        xml.replace(
          '</Relationships>',
          '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/huge.bin"/></Relationships>',
        ),
      )
    } else if (name === '[Content_Types].xml') {
      const xml = decoder.decode(data)
      data = encoder.encode(
        xml.replace(
          '</Types>',
          '<Default Extension="bin" ContentType="application/octet-stream"/></Types>',
        ),
      )
    }
    parts.push({ name, data })
  }
  const out = createWriteStream(path)
  let offset = 0
  const write = async (chunk: Buffer) => {
    if (!out.write(chunk)) await once(out, 'drain')
    offset += chunk.length
  }
  const centrals: Buffer[] = []
  for (const part of parts) {
    const name = Buffer.from(part.name, 'utf8')
    const data = Buffer.from(part.data)
    const crc = crc32(data) >>> 0
    centrals.push(Buffer.concat([centralHeader(name, data.length, crc, offset), name]))
    await write(localHeader(name, data.length, crc))
    await write(name)
    await write(data)
  }
  const mediaName = Buffer.from('ppt/media/huge.bin', 'utf8')
  let mediaCrc = 0
  const chunk = Buffer.alloc(8 * 1024 * 1024)
  for (let written = 0; written < mediaBytes; written += chunk.length) {
    const current = chunk.subarray(0, Math.min(chunk.length, mediaBytes - written))
    mediaCrc = crc32(current, mediaCrc)
  }
  const mediaOffset = offset
  await write(localHeader(mediaName, mediaBytes, mediaCrc))
  await write(mediaName)
  for (let written = 0; written < mediaBytes; written += chunk.length) {
    const current = chunk.subarray(0, Math.min(chunk.length, mediaBytes - written))
    await write(current)
  }
  centrals.push(
    Buffer.concat([centralHeader(mediaName, mediaBytes, mediaCrc, mediaOffset), mediaName]),
  )
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const centralOffset = offset
  for (const central of centrals) await write(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(centrals.length, 8)
  eocd.writeUInt16LE(centrals.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralOffset, 16)
  out.end(eocd)
  await once(out, 'close')
}

async function upload(url: string, path: string): Promise<{ fileId: string; size: number }> {
  const info = await stat(path)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        hostname: new URL(url).hostname,
        port: new URL(url).port,
        path: '/v1/files',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          if (res.statusCode !== 201) reject(new Error(`upload HTTP ${res.statusCode}: ${body}`))
          else resolve(JSON.parse(body) as { fileId: string; size: number })
        })
      },
    )
    req.on('error', reject)
    import('node:fs').then(({ createReadStream }) => createReadStream(path).pipe(req))
  })
}

async function health(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/v1/health`)
  return (await response.json()) as Record<string, unknown>
}

async function openSession(
  url: string,
  fileId: string,
): Promise<{ status: number; sessionId?: string }> {
  const response = await fetch(`${url}/v1/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  })
  const body = (await response.json()) as { sessionId?: string }
  return { status: response.status, sessionId: body.sessionId }
}

const target = arg('url', 'http://127.0.0.1:8787')
const mediaBytes = parseSize(arg('size', '1G'))
const sessions = Number(arg('sessions', '4'))
const temp = await mkdtemp(join(tmpdir(), 'parse-server-stress-'))
const deck = join(temp, 'large.pptx')
const started = Date.now()
let timeoutServer: Awaited<ReturnType<typeof createParseServer>> | undefined
try {
  console.log(`[stress] writing ${mediaBytes} bytes of media -> ${deck}`)
  await writeLargeDeck(deck, mediaBytes)
  const before = await health(target)
  console.log('[stress] health before', JSON.stringify(before))
  const uploaded = await upload(target, deck)
  console.log(`[stress] uploaded ${uploaded.size} bytes, fileId=${uploaded.fileId}`)
  const opened = await Promise.all(
    Array.from({ length: sessions }, () => openSession(target, uploaded.fileId)),
  )
  const statuses = opened.map((item) => item.status)
  console.log('[stress] concurrent session statuses', statuses)
  const firstSession = opened.find((item) => item.status === 201)?.sessionId
  const healthBeforePart = await health(target)
  let partStatus = 0
  let rangeStatus = 0
  let mediaUrl = ''
  if (firstSession) {
    const unit = (await (await fetch(`${target}/v1/sessions/${firstSession}/units/0`)).json()) as {
      slide?: unknown
    }
    const urls: string[] = []
    const walk = (value: unknown) => {
      if (typeof value === 'string' && value.includes('/v1/files/')) urls.push(value)
      else if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(unit.slide)
    mediaUrl = urls.find((url) => url.includes('/parts/')) ?? ''
    if (mediaUrl) {
      partStatus = (await fetch(mediaUrl, { method: 'HEAD' })).status
      rangeStatus = (await fetch(mediaUrl, { headers: { Range: 'bytes=0-1048575' } })).status
    }
  }
  const after = await health(target)
  console.log('[stress] health after', JSON.stringify(after))
  console.log('[stress] media part HEAD', partStatus, 'Range', rangeStatus, mediaUrl)
  await Promise.all(
    opened
      .filter((item) => item.sessionId)
      .map((item) =>
        fetch(`${target}/v1/sessions/${item.sessionId}`, { method: 'DELETE' }).catch(
          () => undefined,
        ),
      ),
  )

  const timeoutDir = await mkdtemp(join(tmpdir(), 'parse-server-timeout-'))
  timeoutServer = await createParseServer({ dataDir: timeoutDir, parseTimeoutMs: 1 })
  const small = await upload(timeoutServer.url, await writeSmallDeck(temp))
  const timeoutResult = await openSession(timeoutServer.url, small.fileId)
  const timeoutStatus = timeoutResult.status
  const timeoutHealth = await health(timeoutServer.url)
  console.log('[stress] timeout status', timeoutStatus, 'health', JSON.stringify(timeoutHealth))
  await timeoutServer.close()
  timeoutServer = undefined
  await rm(timeoutDir, { recursive: true, force: true })

  console.log(
    JSON.stringify(
      {
        mediaBytes,
        uploadBytes: uploaded.size,
        sessionStatuses: statuses,
        healthBefore: before,
        healthBeforePart,
        healthAfter: after,
        timeoutStatus,
        timeoutHealth,
        mediaUrl,
        mediaHeadStatus: partStatus,
        mediaRangeStatus: rangeStatus,
        elapsedSec: Math.round((Date.now() - started) / 100) / 10,
      },
      null,
      2,
    ),
  )
} finally {
  await timeoutServer?.close().catch(() => undefined)
  await rm(temp, { recursive: true, force: true })
}

async function writeSmallDeck(dir: string): Promise<string> {
  const path = join(dir, 'small.pptx')
  const bytes = Buffer.from(await createBlankPptx())
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, bytes)
  return path
}
