import { open } from 'node:fs/promises'

export const MEDIA_PROFILE =
  'web-media-v3:reuse-h264-l51:encode-high-l41-1080p30-tv:aac-lc:mp3-192k:faststart'
export type MediaKind = 'video' | 'audio'
export type MediaStrategy = 'reuse' | 'remux' | 'transcode'
export interface MediaProbe {
  format: { format_name?: string; duration?: string; tags?: { major_brand?: string } }
  streams: Array<{
    index: number
    codec_type: string
    codec_name: string
    profile?: string
    pix_fmt?: string
    width?: number
    height?: number
    level?: number
    avg_frame_rate?: string
    disposition?: { attached_pic?: number }
  }>
}

export function mediaStreams(probe: MediaProbe, kind: MediaKind) {
  const video = probe.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = probe.streams?.find((s) => s.codec_type === 'audio')
  if (
    (kind === 'video' && !video) ||
    (kind === 'audio' && !audio) ||
    !Number.isFinite(Number(probe.format?.duration)) ||
    Number(probe.format.duration) <= 0
  )
    throw Object.assign(new Error('媒体没有可用的音视频流或有效时长。'), { code: 'media_invalid' })
  return { video, audio }
}

export function mediaStrategy(
  probe: MediaProbe,
  kind: MediaKind,
  faststart: boolean,
): MediaStrategy {
  const { video, audio } = mediaStreams(probe, kind)
  const formats = probe.format.format_name?.split(',') ?? []
  if (kind === 'audio') {
    if (audio!.codec_name !== 'mp3') return 'transcode'
    return formats.includes('mp3') ? 'reuse' : 'remux'
  }
  const compatible =
    video!.codec_name === 'h264' &&
    ['yuv420p', 'yuvj420p'].includes(video!.pix_fmt ?? '') &&
    ['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(video!.profile ?? '') &&
    (video!.level ?? 999) <= 51 &&
    (!audio || (audio.codec_name === 'aac' && audio.profile === 'LC'))
  if (!compatible) return 'transcode'
  return formats.includes('mp4') && probe.format.tags?.major_brand?.trim() !== 'qt' && faststart
    ? 'reuse'
    : 'remux'
}

/** Read only top-level atom headers; never search arbitrary compressed payload. */
export async function hasFaststart(path: string): Promise<boolean> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    let offset = 0
    for (let count = 0; count < 1024 && offset + 8 <= size; count++) {
      const header = Buffer.alloc(16)
      const read = await file.read(header, 0, Math.min(16, size - offset), offset)
      if (read.bytesRead < 8) return false
      let length = header.readUInt32BE(0)
      if (length === 1) {
        if (read.bytesRead < 16) return false
        const large = header.readBigUInt64BE(8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return false
        length = Number(large)
      }
      if (length === 0) length = size - offset
      if (length < 8 || offset + length > size) return false
      const type = header.toString('ascii', 4, 8)
      if (type === 'moov') return true
      if (type === 'mdat') return false
      offset += length
    }
    return false
  } finally {
    await file.close()
  }
}
