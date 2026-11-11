import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DownloadLimitError, readResponseLimited } from '../src/web/fetch-limited.ts'

function streamResponse(chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers })
}

test('counts streamed bytes and returns the concatenated body', async () => {
  const bytes = await readResponseLimited(
    streamResponse([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
    10,
  )
  assert.deepEqual([...bytes], [1, 2, 3, 4, 5])
})

test('rejects a declared length above the limit before buffering the body', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
      controller.close()
    },
  })
  await assert.rejects(
    readResponseLimited(new Response(stream, { headers: { 'content-length': '100' } }), 10),
    DownloadLimitError,
  )
})

test('enforces the limit on chunked responses even when Content-Length lies', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
      controller.enqueue(new Uint8Array(8))
      controller.close()
    },
  })
  await assert.rejects(
    readResponseLimited(new Response(stream, { headers: { 'content-length': '1' } }), 10),
    DownloadLimitError,
  )
})

test('falls back to arrayBuffer for a null body and validates the limit', async () => {
  assert.equal((await readResponseLimited(new Response(null), 10)).length, 0)
  await assert.rejects(readResponseLimited(new Response('x'), 0), /invalid download limit/)
})
