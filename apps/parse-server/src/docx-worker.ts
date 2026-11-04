import { readFile, stat } from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'
import { createDocxBlockParser } from '@genoffice/docx-engine'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import { ParseLimitError } from './pptx-slim'
import { openDocxDocumentStream, streamDocxBlocks } from './docx-stream'
import { scanDocxMetadata } from './docx-metadata'
import { readChunk, readChunkManifest, writeChunk, writeChunkManifest } from './docx-chunks'

interface OpenInput {
  id: string
  fileId: string
  path: string
  parserVersion: string
  limits: ServerLimits
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
let persisted = false
let chunksDir = ''
let lastUsed = Date.now()

async function open(input: OpenInput): Promise<{ model: DocModel; fonts: never[] }> {
  chunksDir = input.chunksDir
  const manifest = await readChunkManifest(input.chunksDir)
  if (
    manifest &&
    manifest.fileId === input.fileId &&
    manifest.parserVersion === input.parserVersion
  ) {
    persisted = true
    chunkCount = manifest.unitCount
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
    return { model, fonts: [] }
  }
  const info = await stat(input.path)
  if (info.size > input.limits.maxParseBytes) throw new ParseLimitError(input.limits.maxParseBytes)
  const bytes = await readFile(input.path)
  const metadata = await scanDocxMetadata(await openDocxDocumentStream(input.path, input.limits))
  const parser = await createDocxBlockParser(bytes, metadata)
  const slices = []
  for await (const slice of streamDocxBlocks(
    await openDocxDocumentStream(input.path, input.limits),
  )) {
    slices.push(slice)
  }
  const blocks = []
  for (let index = 0; index < slices.length; index++) {
    blocks.push(await parser.parseBlock(slices[index].xml, index, slices[index].start))
  }
  const parsedChunks: any[][] = []
  for (let offset = 0; offset < blocks.length; offset += CHUNK_BLOCKS) {
    parsedChunks.push(blocks.slice(offset, offset + CHUNK_BLOCKS))
  }
  for (let index = 0; index < parsedChunks.length; index++) {
    await writeChunk(input.chunksDir, index, parsedChunks[index])
  }
  await writeChunkManifest(input.chunksDir, {
    version: 1,
    fileId: input.fileId,
    parserVersion: input.parserVersion,
    unitCount: parsedChunks.length,
    chunkBlocks: CHUNK_BLOCKS,
    createdAt: Date.now(),
  })
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
  return { model, fonts: [] }
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
            blocks: persisted ? await readChunk(chunksDir, index) : chunks[index],
            playback: [],
          })
          break
        }
        case 'font':
          respond(null)
          break
        case 'widths':
          respond([])
          break
        case 'close':
          chunks = []
          model = null
          chunkCount = 0
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
