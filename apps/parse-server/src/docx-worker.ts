import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import { parentPort } from 'node:worker_threads'
import { createDocxBlockParser, readDocxEmbeddedFonts } from '@genoffice/docx-engine'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import { streamDocxBlocks } from './docx-stream'
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
}

interface Message {
  id: number
  method: string
  params?: any
}

const CHUNK_BLOCKS = 200
let model: DocModel | null = null
let chunks: any[][] = []
let chunkCount = 0
let chunkManifest: ChunkManifest | null = null
let fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean; data: Uint8Array }> =
  []
let persisted = false
let chunksDir = ''
let lastUsed = Date.now()

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
    block.imageDataUrl = `${baseUrl.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileId)}/parts/${encodeURI(partPath)}`
  }
}

async function open(input: OpenInput): Promise<{
  model: DocModel
  fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean; also: string[] }>
}> {
  chunksDir = input.chunksDir
  const slim = await slimDocxFile(input.path, input.limits)
  const bytes = slim.bytes
  const zip = await JSZip.loadAsync(bytes)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('not a docx: missing word/document.xml')
  const documentXml = await documentFile.async('string')
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
      stagesDone: ['index', 'model'],
      stagesPending: [],
      warnings: [],
    }
    return { model, fonts: fontSummaries }
  }
  const metadata = await scanDocxMetadata(Readable.from([documentXml]))
  const parser = await createDocxBlockParser(bytes, metadata)
  const slices = []
  for await (const slice of streamDocxBlocks(Readable.from([documentXml]))) slices.push(slice)
  const blocks = []
  for (let index = 0; index < slices.length; index++) {
    blocks.push(await parser.parseBlock(slices[index].xml, index, slices[index].start))
  }
  await rewriteImages(blocks, bytes, input.baseUrl, input.fileId)
  const parsedChunks: any[][] = []
  for (let offset = 0; offset < blocks.length; offset += CHUNK_BLOCKS) {
    parsedChunks.push(blocks.slice(offset, offset + CHUNK_BLOCKS))
  }
  const entries = await writeChunks(input.chunksDir, parsedChunks)
  const nextManifest: ChunkManifest = {
    version: 2,
    fileId: input.fileId,
    parserVersion: input.parserVersion,
    unitCount: parsedChunks.length,
    chunkBlocks: CHUNK_BLOCKS,
    chunkFile: 'chunks.bin',
    chunks: entries,
    createdAt: Date.now(),
  }
  chunkManifest = nextManifest
  await writeChunkManifest(input.chunksDir, nextManifest)
  persisted = true
  chunkCount = parsedChunks.length
  chunks = []
  model = {
    format: 'docx',
    parserVersion: input.parserVersion,
    unitKind: 'block-chunk',
    unitCount: chunkCount,
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
          lastUsed = Date.now()
          respond(units(message.params?.cursor, message.params?.limit))
          break
        case 'unit': {
          if (!model) throw new Error('docx: session is not open')
          lastUsed = Date.now()
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
        case 'widths':
          respond([])
          break
        case 'close':
          chunks = []
          model = null
          chunkCount = 0
          fonts = []
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
