import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { parentPort } from 'node:worker_threads'
import JSZip from 'jszip'
import { createDocxBlockParser } from '@genoffice/docx-engine'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import { ParseLimitError } from './pptx-slim'
import { streamDocxBlocks } from './docx-stream'

interface OpenInput {
  id: string
  fileId: string
  path: string
  parserVersion: string
  limits: ServerLimits
}

interface Message {
  id: number
  method: string
  params?: any
}

const CHUNK_BLOCKS = 200
let model: DocModel | null = null
let chunks: any[][] = []
let lastUsed = Date.now()

async function open(input: OpenInput): Promise<{ model: DocModel; fonts: never[] }> {
  const info = await stat(input.path)
  if (info.size > input.limits.maxParseBytes) throw new ParseLimitError(input.limits.maxParseBytes)
  const bytes = await readFile(input.path)
  const zip = await JSZip.loadAsync(bytes)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('not a docx: missing word/document.xml')
  const documentXml = await documentFile.async('string')
  const parser = await createDocxBlockParser(bytes)
  const slices = []
  for await (const slice of streamDocxBlocks(Readable.from([documentXml]))) slices.push(slice)
  const blocks = []
  for (let index = 0; index < slices.length; index++) {
    blocks.push(await parser.parseBlock(slices[index].xml, index))
  }
  chunks = []
  for (let offset = 0; offset < blocks.length; offset += CHUNK_BLOCKS) {
    chunks.push(blocks.slice(offset, offset + CHUNK_BLOCKS))
  }
  model = {
    format: 'docx',
    parserVersion: input.parserVersion,
    unitKind: 'block-chunk',
    unitCount: chunks.length,
    stagesDone: ['index', 'model'],
    stagesPending: [],
    warnings: [],
  }
  return { model, fonts: [] }
}

function units(cursor?: string, limit = 100): { items: UnitSummary[]; next?: string } {
  if (!model) throw new Error('docx: session is not open')
  const total = chunks.length
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
          if (!Number.isInteger(index) || index < 0 || index >= chunks.length) {
            throw new Error('docx: unknown block chunk')
          }
          respond({
            id: String(index),
            kind: 'block-chunk',
            index,
            blocks: chunks[index],
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
