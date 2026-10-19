import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPptxSession, type PptxDeck } from '../src/web/pptx-session.ts'

test('measurement patches preserve untouched pages and closing rejects outstanding reads', async () => {
  const original = globalThis.Worker
  class WorkerStub {
    static instance: WorkerStub
    onmessage?: (event: { data: unknown }) => void
    onerror?: (event: unknown) => void
    sent: Array<{ id: number; op: string; input: unknown }> = []
    terminated = false
    constructor() { WorkerStub.instance = this }
    postMessage(message: { id: number; op: string; input: unknown }) { this.sent.push(message) }
    terminate() { this.terminated = true }
    reply(result: unknown) { this.onmessage?.({ data: { id: this.sent.at(-1)!.id, result } }) }
  }
  globalThis.Worker = WorkerStub as unknown as typeof Worker
  try {
    const session = createPptxSession()
    const worker = WorkerStub.instance
    const slides = [{ nodes: ['first'] }, { nodes: ['second'] }, { nodes: ['third'] }]
    const deck: PptxDeck = { slides, fonts: [], playback: [], media: [], fallbacks: [], measurements: [] }
    const opening = session.open(new ArrayBuffer(4))
    worker.reply(deck)
    await opening
    const refining = session.measure({ key: 123 })
    const replacement = { nodes: ['refined second'] }
    worker.reply({ slideUpdates: [[1, replacement]], measurements: [], fallbacks: [] })
    const refined = await refining
    assert.equal(refined.slides[0], slides[0])
    assert.equal(refined.slides[1], replacement)
    assert.equal(refined.slides[2], slides[2])
    const outstanding = session.bytes('ppt/media/large.png')
    const rejected = assert.rejects(outstanding, /Presentation closed/)
    session.close()
    await rejected
    assert.equal(worker.terminated, true)
    await assert.rejects(session.bytes('another.png'), /Presentation closed/)
  } finally { globalThis.Worker = original }
})
