import assert from 'node:assert/strict'
import { test } from 'node:test'
import { imageDpiFromBytes, imageSizeFromBytes } from '@genoffice/pptx-render'
import type { OpenedPptx } from '@genoffice/pptx-engine'
import { createBrowserMedia, MEDIA_HEAD_BYTES } from '../src/web/browser-media.ts'

/** Decode the head of a data url the way pptx-render's readers do. */
function head(dataUrl: string) {
  const comma = dataUrl.indexOf(',')
  return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), 'base64'))
}

/** A real PNG (IHDR + pHYs + IDAT + IEND) so the dpi and size readers have something to parse. */
function png(width: number, height: number, pixelsPerMetre: number, padding = 0) {
  const u32 = (value: number) => [
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]
  const chunk = (type: string, data: number[]) => {
    const body = [...type.split('').map((c) => c.charCodeAt(0)), ...data]
    return [...u32(data.length), ...body, 0, 0, 0, 0]
  }
  const parts = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    chunk('pHYs', [...u32(pixelsPerMetre), ...u32(pixelsPerMetre), 1]),
    chunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
    chunk('IEND', []),
  ].flat()
  return new Uint8Array([...parts, ...new Array(padding).fill(0)])
}

function archiveOf(parts: Record<string, Uint8Array>) {
  return { archive: { readBytes: (ref: string) => parts[ref] ?? null } } as unknown as OpenedPptx
}

test('small media parts stay inline data urls', () => {
  const opened = archiveOf({ 'ppt/media/small.png': png(64, 64, 3780) })
  const media = createBrowserMedia(opened)
  const url = media.resolve('ppt/media/small.png')!
  assert.ok(url.startsWith('data:image/png;base64,'))
  assert.equal(media.refs.size, 0, 'nothing is handed over as bytes')
  assert.deepEqual(imageDpiFromBytes(head(url)), { x: 96.012, y: 96.012 })
})

test('a big part becomes its head plus the part bytes, with the same header', () => {
  const bytes = png(1920, 1080, 3780, 80 * 1024)
  assert.ok(bytes.length > MEDIA_HEAD_BYTES)
  const opened = archiveOf({ 'ppt/media/big.png': bytes })
  const media = createBrowserMedia(opened)
  const key = media.resolve('ppt/media/big.png')!
  assert.equal(media.refs.get(key), 'ppt/media/big.png', 'the descriptor names its part')
  // the descriptor is the head the readers decode, so every number they report is the same
  assert.deepEqual(head(key), bytes.subarray(0, MEDIA_HEAD_BYTES))
  assert.ok(
    key.length < 128 * 1024,
    'the tree carries a head, not the payload (a 156 MB deck of these is the OOM)',
  )
  assert.deepEqual(imageDpiFromBytes(head(key)), imageDpiFromBytes(bytes))
  assert.deepEqual(imageSizeFromBytes(head(key)), { w: 1920, h: 1080 })
})

test('metafiles stay inline for the loader to rasterize', () => {
  // EMF/WMF carry device bounds the page needs whole; a head would be meaningless
  const emf = new Uint8Array([1, 0, 9, 0, ...new Array(MEDIA_HEAD_BYTES + 16).fill(7)])
  const media = createBrowserMedia(archiveOf({ 'ppt/media/pic.emf': emf }))
  const url = media.resolve('ppt/media/pic.emf')!
  assert.ok(url.startsWith('data:image/x-emf;base64,'), 'full payload, no descriptor')
  assert.equal(media.refs.size, 0)
})
