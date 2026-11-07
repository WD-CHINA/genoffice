import JSZip from 'jszip'
import { parentPort } from './worker-channel'
import {
  createDocxBlockParser,
  readDocxEmbeddedFonts,
  readDocxStyleContext,
  sectionSettingsFromXml,
} from '@genoffice/docx-engine'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import { streamDocxBlocks, openDocxDocumentStream } from './docx-stream'
import { slimDocxFile } from './docx-slim'
import { scanDocxMetadata } from './docx-metadata'
import {
  readChunk,
  readChunkManifest,
  writeChunkManifest,
  writeChunks,
  type ChunkManifest,
} from './docx-chunks'

interface OpenInput {
  id: string
  fileId: string
  path: string
  parserVersion: string
  limits: ServerLimits
  baseUrl: string
  /** Directory for persisted chunk JSON files. */
  chunksDir: string
  storageReservation?: boolean
}

interface Message {
  id: number
  method: string
  params?: any
}

let reserveEnabled = false
let nextStorageId = 0
const storageRequests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
function reserveStorage(bytes: number): Promise<void> {
  if (!reserveEnabled) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const storageId = nextStorageId++
    storageRequests.set(storageId, { resolve, reject })
    parentPort!.postMessage({ kind: 'storage_reserve', storageId, bytes })
  })
}

const CHUNK_BLOCKS = 200
let model: DocModel | null = null
let chunks: any[][] = []
let chunkCount = 0
let chunkManifest: ChunkManifest | null = null
let fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean; data: Uint8Array }> =
  []
let styleContext: unknown = null
let persisted = false
let chunksDir = ''

async function rewriteImages(
  blocks: any[],
  bytes: Uint8Array,
  baseUrl: string,
  fileId: string,
): Promise<void> {
  const imageBlocks = blocks.filter(
    (block) =>
      typeof block.imageDataUrl === 'string' && block.imageDataUrl.startsWith('data:image/'),
  )
  if (!imageBlocks.length) return
  const zip = await JSZip.loadAsync(bytes)
  const relsFile = zip.file('word/_rels/document.xml.rels')
  if (!relsFile) return
  const rels = new Map<string, string>()
  for (const match of (await relsFile.async('string')).matchAll(
    /<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g,
  )) {
    rels.set(match[1], match[2])
  }
  for (const block of imageBlocks) {
    const embed = /r:embed="([^"]+)"/.exec(block.originalXml || '')?.[1]
    if (!embed) continue
    const target = rels.get(embed)
    if (!target || /^https?:/i.test(target)) continue
    const partPath = target.startsWith('/') ? target.slice(1) : `word/${target}`
    block.imageDataUrl = `${baseUrl.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileId)}/parts/${partPath.split('/').map(encodeURIComponent).join('/')}`
  }
}

async function open(input: OpenInput): Promise<{
  model: DocModel
  fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean; also: string[] }>
}> {
  reserveEnabled = !!input.storageReservation
  chunksDir = input.chunksDir
  const slim = await slimDocxFile(input.path, input.limits, { omitDocument: true })
  const bytes = slim.bytes
  styleContext = await readDocxStyleContext(bytes)
  const embedded = await readDocxEmbeddedFonts(bytes)
  fonts = embedded.map((font, index) => ({
    id: `font-${index}`,
    family: font.family,
    bold: font.bold,
    italic: font.italic,
    data: font.data,
  }))
  const fontSummaries = fonts.map(({ id, family, bold, italic }) => ({
    id,
    family,
    bold,
    italic,
    also: [],
  }))
  const metadata = await scanDocxMetadata(await openDocxDocumentStream(input.path, input.limits))
  const settings = sectionSettingsFromXml(metadata.sections.at(-1)?.xml ?? '', {})
  const manifest = await readChunkManifest(input.chunksDir)
  if (
    manifest &&
    manifest.fileId === input.fileId &&
    manifest.parserVersion === input.parserVersion
  ) {
    persisted = true
    chunkCount = manifest.unitCount
    chunkManifest = manifest
    chunks = []
    model = {
      format: 'docx',
      parserVersion: input.parserVersion,
      unitKind: 'block-chunk',
      unitCount: chunkCount,
      page: {
        pageWidth: settings.pageWidth,
        pageHeight: settings.pageHeight,
        marginTop: settings.marginTop,
        marginRight: settings.marginRight,
        marginBottom: settings.marginBottom,
        marginLeft: settings.marginLeft,
      },
      stagesDone: ['index', 'model'],
      stagesPending: [],
      warnings: [],
    }
    return { model, fonts: fontSummaries }
  }
  const parser = await createDocxBlockParser(bytes, {
    ...metadata,
    mediaUrl: (partPath) =>
      `${input.baseUrl.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(input.fileId)}/parts/${partPath.split('/').map(encodeURIComponent).join('/')}`,
  })
  async function* parsedChunks(): AsyncGenerator<unknown[]> {
    let batch: any[] = []
    for await (const slice of streamDocxBlocks(
      await openDocxDocumentStream(input.path, input.limits),
    )) {
      batch.push(await parser.parseBlock(slice.xml, slice.docxIndex, slice.start))
      if (batch.length >= CHUNK_BLOCKS) {
        await rewriteImages(batch, bytes, input.baseUrl, input.fileId)
        yield batch
        batch = []
      }
    }
    if (batch.length) {
      await rewriteImages(batch, bytes, input.baseUrl, input.fileId)
      yield batch
    }
  }
  const entries = await writeChunks(input.chunksDir, parsedChunks(), reserveStorage)
  const nextManifest: ChunkManifest = {
    version: 2,
    fileId: input.fileId,
    parserVersion: input.parserVersion,
    unitCount: entries.length,
    chunkBlocks: CHUNK_BLOCKS,
    chunkFile: 'chunks.bin',
    chunks: entries,
    createdAt: Date.now(),
  }
  chunkManifest = nextManifest
  await writeChunkManifest(input.chunksDir, nextManifest, reserveStorage)
  persisted = true
  chunkCount = entries.length
  chunks = []
  model = {
    format: 'docx',
    parserVersion: input.parserVersion,
    unitKind: 'block-chunk',
    unitCount: chunkCount,
    page: {
      pageWidth: settings.pageWidth,
      pageHeight: settings.pageHeight,
      marginTop: settings.marginTop,
      marginRight: settings.marginRight,
      marginBottom: settings.marginBottom,
      marginLeft: settings.marginLeft,
    },
    stagesDone: ['index', 'model'],
    stagesPending: [],
    warnings: [],
  }
  return { model, fonts: fontSummaries }
}

function units(cursor?: string, limit = 100): { items: UnitSummary[]; next?: string } {
  if (!model) throw new Error('docx: session is not open')
  const total = chunkCount
  const start = cursor ? Number.parseInt(cursor, 10) : 0
  if (!Number.isInteger(start) || start < 0 || start > total) {
    throw new Error('docx: invalid unit cursor')
  }
  const end = Math.min(total, start + Math.max(1, Math.min(limit, 500)))
  const items: UnitSummary[] = []
  for (let index = start; index < end; index++) {
    items.push({ id: String(index), kind: 'block-chunk', index, anchor: String(index) })
  }
  return { items, ...(end < total ? { next: String(end) } : {}) }
}

parentPort?.on('message', (message: Message) => {
  if (message.method === 'storage_reply') {
    const reply = message.params as {
      storageId: number
      error?: { message: string; code?: string }
    }
    const pending = storageRequests.get(reply.storageId)
    if (!pending) return
    storageRequests.delete(reply.storageId)
    if (reply.error) {
      const error = Object.assign(new Error(reply.error.message), { code: reply.error.code })
      pending.reject(error)
    } else pending.resolve()
    return
  }
  const respond = (value: unknown) =>
    parentPort?.postMessage({ id: message.id, ok: true, result: value })
  const fail = (error: unknown) => {
    const err = error as { code?: string; message?: string }
    parentPort?.postMessage({
      id: message.id,
      ok: false,
      error: { message: err?.message ?? String(error), ...(err?.code ? { code: err.code } : {}) },
    })
  }
  void (async () => {
    try {
      switch (message.method) {
        case 'open':
          respond(await open(message.params as OpenInput))
          break
        case 'units':
          respond(units(message.params?.cursor, message.params?.limit))
          break
        case 'unit': {
          if (!model) throw new Error('docx: session is not open')
          const index = Number.parseInt(String(message.params?.id), 10)
          if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
            throw new Error('docx: unknown block chunk')
          }
          respond({
            id: String(index),
            kind: 'block-chunk',
            index,
            blocks: persisted ? await readChunk(chunksDir, index, chunkManifest!) : chunks[index],
            playback: [],
          })
          break
        }
        case 'font': {
          const font = fonts.find((item) => item.id === message.params?.id)
          respond(font ? font.data : null)
          break
        }
        case 'styles':
          respond(styleContext)
          break
        case 'widths':
          respond([])
          break
        case 'close':
          chunks = []
          model = null
          chunkCount = 0
          fonts = []
          styleContext = null
          respond(undefined)
          break
        default:
          throw new Error(`unknown docx worker method: ${message.method}`)
      }
    } catch (error) {
      fail(error)
    }
  })()
})

export type { OpenInput }
