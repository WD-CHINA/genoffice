import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import JSZip from 'jszip'
import { createDocxBlockParser } from '@genoffice/docx-engine'
import type { DocModel, UnitSummary } from '@genoffice/parse-contract'
import type { ServerLimits } from './limits'
import { ParseLimitError } from './pptx-slim'
import { streamDocxBlocks } from './docx-stream'

export interface DocxOpenInput {
  id: string
  fileId: string
  path: string
  parserVersion: string
  baseUrl: string
  limits: ServerLimits
}

const CHUNK_BLOCKS = 200

/**
 * Main-thread DOCX session. Gate A.3 keeps the first version simple: blocks are
 * parsed into in-memory chunks; worker isolation and chunk persistence follow.
 */
export class DocxSession {
  readonly model: DocModel
  readonly fonts: never[] = []
  private readonly chunks: any[][]
  private lastUsed = Date.now()

  private constructor(
    readonly id: string,
    readonly fileId: string,
    model: DocModel,
    chunks: any[][],
  ) {
    this.model = model
    this.chunks = chunks
  }

  static async open(input: DocxOpenInput): Promise<DocxSession> {
    const info = await stat(input.path)
    if (info.size > input.limits.maxParseBytes) {
      throw new ParseLimitError(input.limits.maxParseBytes)
    }
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
    const chunks: any[][] = []
    for (let offset = 0; offset < blocks.length; offset += CHUNK_BLOCKS) {
      chunks.push(blocks.slice(offset, offset + CHUNK_BLOCKS))
    }
    const model: DocModel = {
      format: 'docx',
      parserVersion: input.parserVersion,
      unitKind: 'block-chunk',
      unitCount: chunks.length,
      stagesDone: ['index', 'model'],
      stagesPending: [],
      warnings: [],
    }
    return new DocxSession(input.id, input.fileId, model, chunks)
  }

  touch(): void {
    this.lastUsed = Date.now()
  }

  idleSince(): number {
    return this.lastUsed
  }

  units(cursor?: string, limit = 100): { items: UnitSummary[]; next?: string } {
    const total = this.chunks.length
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

  async unit(id: string): Promise<unknown> {
    const index = Number.parseInt(id, 10)
    if (!Number.isInteger(index) || index < 0 || index >= this.chunks.length) {
      throw new Error('docx: unknown block chunk')
    }
    this.touch()
    return {
      id: String(index),
      kind: 'block-chunk',
      index,
      blocks: this.chunks[index],
      playback: [],
    }
  }

  async fontBytes(_id: string): Promise<Uint8Array | null> {
    return null
  }

  async acceptWidths(_widths: Record<string, number>): Promise<unknown[]> {
    return []
  }

  close(): void {
    // Chunks are plain JSON; nothing to release yet.
  }
}
