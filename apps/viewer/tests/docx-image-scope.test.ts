import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocxImageScope } from '../src/web/docx-image-scope'

test('preserves image bytes and deduplicates clone sources without resampling', async () => {
  const png = 'data:image/png;base64,AQIDBA=='
  const doc = { blocks: [{ imageDataUrl: png }, { runs: [{ src: png }] }], internal: { raw: png } }
  const scope = createDocxImageScope()
  try {
    scope.adopt(doc)
    assert.match(doc.blocks[0]!.imageDataUrl!, /^blob:/)
    assert.equal(doc.blocks[0]!.imageDataUrl, doc.blocks[1]!.runs![0]!.src)
    assert.deepEqual(
      new Uint8Array(await (await fetch(doc.blocks[0]!.imageDataUrl!)).arrayBuffer()),
      new Uint8Array([1, 2, 3, 4]),
    )
    assert.equal(doc.internal.raw, png)
  } finally {
    scope.close()
  }
  await assert.rejects(fetch(doc.blocks[0]!.imageDataUrl!))
})
