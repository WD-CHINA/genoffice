import { DocxReadQueue } from './docx-read-queue'
import { combineAbortSignals } from './abort-signals'
import { sfntLineMetrics } from '@genoffice/docx-engine'

interface EmbeddedFont {
  id: string
  family: string
  bold: boolean
  italic: boolean
}

interface FontHost {
  create(font: EmbeddedFont, bytes: ArrayBuffer): FontFace
  add(face: FontFace): void
  remove(face: FontFace): void
}

/** One document owns these faces, including across lightweight session recovery. */
export class DocxFontScope {
  private closed = false
  private readonly controller = new AbortController()
  private readonly reads = new DocxReadQueue(2)
  private readonly faces = new Map<string, FontFace>()
  private readonly pending = new Map<string, Promise<void>>()
  private readonly metrics = new Map<string, { family: string; styled: boolean; ascent: number; descent: number; lineGap: number }>()

  lineMetrics() { return [...this.metrics.values()].sort((a, b) => Number(a.styled) - Number(b.styled)) }

  constructor(private readonly host: FontHost = {
    create: (font, bytes) => new FontFace(font.family, bytes, {
      weight: font.bold ? 'bold' : 'normal', style: font.italic ? 'italic' : 'normal',
    }),
    add: (face) => { document.fonts.add(face) },
    remove: (face) => { document.fonts.delete(face) },
  }) {}

  async load(server: string, sessionId: string, fonts: readonly EmbeddedFont[],
    headers: Record<string, string>, signal: AbortSignal): Promise<void> {
    const combined = combineAbortSignals([signal, this.controller.signal])
    signal = combined.signal
    let index = 0
    const worker = async () => {
      while (!this.closed && !signal.aborted && index < fonts.length) {
        const font = fonts[index++]
        const key = JSON.stringify([font.id, font.family, font.bold, font.italic])
        if (this.faces.has(key)) continue
        let job = this.pending.get(key)
        if (!job) {
          job = Promise.resolve().then(async () => {
            try {
              await this.reads.run(signal, async () => {
                if (this.closed || signal.aborted) return
                const response = await fetch(
                  `${server.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/fonts/${encodeURIComponent(font.id)}`,
                  { headers, signal },
                )
                if (!response.ok || this.closed || signal.aborted) {
                  await response.body?.cancel()
                  return
                }
                const bytes = await response.arrayBuffer()
                if (this.closed || signal.aborted) return
                const face = this.host.create(font, bytes)
                await face.load()
                if (this.closed || signal.aborted) return
                this.host.add(face)
                this.faces.set(key, face)
                const metrics = sfntLineMetrics(new Uint8Array(bytes))
                if (metrics) this.metrics.set(key, { family: font.family, styled: font.bold || font.italic, ...metrics })
              })
            } catch {
              // Optional embedded fonts must not prevent fallback-font rendering.
            }
          })
          this.pending.set(key, job)
        }
        await job
        if (this.pending.get(key) === job) this.pending.delete(key)
      }
    }
    // Do not fetch and decode every embedded font concurrently.
    try { await Promise.all([worker(), worker()]) }
    finally { combined.dispose() }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.controller.abort()
    for (const face of this.faces.values()) this.host.remove(face)
    this.faces.clear()
    this.pending.clear()
    this.metrics.clear()
  }
}
