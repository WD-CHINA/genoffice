import { expect, it } from 'vitest'
import { mediaStrategy, mediaStreams, type MediaProbe } from '../src/media-policy'
import { mediaProcess } from '../src/media-process'
import { resolveMediaOptions } from '../src/media-options'

const video = (codec = 'h264', pix_fmt = 'yuv420p'): MediaProbe => ({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '2', tags: { major_brand: 'isom' } },
  streams: [{ index: 0, codec_type: 'video', codec_name: codec, pix_fmt, profile: 'High', level: 40 },
    { index: 1, codec_type: 'audio', codec_name: 'aac', profile: 'LC' }],
})
it('reuses compatible MP4, remuxes a tail index or QuickTime, and converts incompatible streams', () => {
  expect(mediaStrategy(video(), 'video', true)).toBe('reuse')
  expect(mediaStrategy(video(), 'video', false)).toBe('remux')
  const quicktime = video(); quicktime.format.tags!.major_brand = 'qt  '
  expect(mediaStrategy(quicktime, 'video', true)).toBe('remux')
  expect(mediaStrategy(video('hevc', 'yuv420p10le'), 'video', true)).toBe('transcode')
  const wma = video(); wma.streams[1]!.codec_name = 'wmav2'
  expect(mediaStrategy(wma, 'video', true)).toBe('transcode')
})
it('honors the PPT audio role despite a video track and ignores cover art as video', () => {
  expect(mediaStrategy(video(), 'audio', true)).toBe('transcode')
  const cover: MediaProbe = { format: { format_name: 'mp3', duration: '2' }, streams: [
    { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
    { index: 1, codec_type: 'audio', codec_name: 'mp3' },
  ] }
  expect(mediaStrategy(cover, 'audio', false)).toBe('reuse')
  expect(() => mediaStreams(cover, 'video')).toThrow()
  expect(() => mediaStreams({ format: { duration: '2' }, streams: [] }, 'audio')).toThrow()
})
it('bounds the subprocess and handles an already-aborted request', async () => {
  await expect(mediaProcess(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 30 }))
    .rejects.toMatchObject({ code: 'media_timeout' })
  const controller = new AbortController(); controller.abort()
  await expect(mediaProcess(process.execPath, ['-e', ''], { timeoutMs: 1000, signal: controller.signal })).rejects.toBeDefined()
})
it('rejects invalid resource and queue limits', () => {
  expect(() => resolveMediaOptions({ concurrency: 0 })).toThrow()
  expect(() => resolveMediaOptions({ maxCacheBytes: 1 })).toThrow()
  expect(() => resolveMediaOptions({ leaseMs: 1 })).toThrow()
})
