import { readFile } from 'node:fs/promises'
import { openPptx, addMedia, savePptx } from '@genoffice/pptx-engine'

/** Synthetic PCM audio and a generated VP8 clip; no user document is modified. */
export async function mediaFixture() {
  const original = await readFile(
    new URL(
      '../../../packages/pptx-engine/tests/fixtures/01_standard_business.pptx',
      import.meta.url,
    ),
  )
  const opened = await openPptx(original)
  const video = await readFile(new URL('./fixtures/test-video.webm', import.meta.url))
  const rate = 8000,
    samples = rate * 4
  const audio = Buffer.alloc(44 + samples * 2)
  audio.write('RIFF')
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(rate, 24)
  audio.writeUInt32LE(rate * 2, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(samples * 2, 40)
  // Silent PCM still exercises the decoder and media clock without audible tests.
  addMedia(opened, 0, {
    kind: 'video',
    ext: 'webm',
    bytes: video,
    name: 'Test video',
    offset: { x: 914400, y: 1371600, cx: 3657600, cy: 2057400 },
  })
  addMedia(opened, 0, {
    kind: 'audio',
    ext: 'wav',
    bytes: audio,
    name: 'Test audio',
    offset: { x: 5486400, y: 1371600, cx: 914400, cy: 914400 },
  })
  addMedia(opened, 0, {
    kind: 'video',
    ext: 'webm',
    bytes: new Uint8Array([1, 2, 3]),
    name: 'Broken video',
    offset: { x: 5486400, y: 2743200, cx: 1828800, cy: 1028700 },
  })
  return { deck: await savePptx(opened), video, audio }
}
