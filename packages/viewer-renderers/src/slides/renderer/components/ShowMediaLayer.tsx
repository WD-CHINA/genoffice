/**
 * Audio/video layer during a show: DOM players stacked over video/audio nodes.
 * In the editor media only has poster frames; a show must be able to play, or decks
 * with video are crippled. Playback is driven two ways, like PowerPoint:
 * - media animations (Play / Pause / Stop in the click sequence) arrive as `commands`
 *   from the animation player and are applied in order as the cursor reaches them;
 * - a click on the media itself toggles play/pause ("When Clicked On").
 * Everything stops when the page turns (the layer remounts per slide).
 */
import React, { useEffect, useRef, useState } from 'react'
import type { PictureRenderNode, RenderSlide } from '@genoffice/pptx-render'
import type { SlidesDataSource } from '../data-source'
import type { MediaCommand } from '../animation-play'

export function ShowMediaLayer({
  slide,
  dataSource,
  slideIndex,
  width,
  commands,
  epoch,
  mediaBase,
  muted = false,
  interactive = true,
}: {
  dataSource: SlidesDataSource
  slide: RenderSlide
  slideIndex: number
  width: number
  commands: MediaCommand[]
  /** Player load/seek generation: the applied cursor is re-based on mediaBase when it changes */
  epoch: number
  /** Commands the player's load/seek already counts as fired (see AnimPlayer.mediaBase) */
  mediaBase: number
  /** Presenter's own preview: plays in sync but silent (the audience window carries the sound) */
  muted?: boolean
  /** false = clicks fall through (presenter stage keeps its ink tools) */
  interactive?: boolean
}) {
  const k = width / slide.widthPx
  const nodes = slide.nodes.filter(
    (n): n is PictureRenderNode => n.type === 'picture' && !!(n as PictureRenderNode).media,
  )
  const [urls, setUrls] = useState<Record<string, { kind: 'video' | 'audio'; dataUrl: string }>>({})
  const [playing, setPlaying] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const els = useRef(new Map<string, HTMLMediaElement>())
  const refs = useRef(new Map<string, (element: HTMLMediaElement | null) => void>())
  useEffect(() => {
    let cancelled = false
    setUrls({})
    setPlaying({})
    setError('')
    for (const n of nodes) {
      void dataSource
        .getMediaData(slideIndex, n.sourceId)
        .then((d) => {
          if (!cancelled && d) setUrls((u) => ({ ...u, [n.sourceId]: d }))
          else if (!cancelled) setError('文档中的媒体资源不存在或未嵌入。')
        })
        .catch(() => {
          if (!cancelled) setError('无法加载媒体资源，请重新打开文档后重试。')
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideIndex])

  // Apply the commands not seen yet, in order; a command whose element has not mounted
  // (media bytes still loading) blocks the tail until the URL arrives. A load/seek re-bases
  // the cursor on what the player counts as already fired (never below it, so a page landed
  // on in its played state stays silent; never above what was applied, so the audience's
  // per-cursor seeks keep firing the steps reached since). Callers key the layer per slide.
  const applied = useRef(0)
  const seenEpoch = useRef<number | null>(null)
  useEffect(() => {
    if (seenEpoch.current !== epoch) {
      seenEpoch.current = epoch
      applied.current = Math.max(Math.min(applied.current, commands.length), mediaBase)
    }
    while (applied.current < commands.length) {
      const c = commands[applied.current]!
      const el = els.current.get(c.sourceId)
      if (!el) {
        if (!nodes.some((n) => n.sourceId === c.sourceId)) {
          applied.current++
          continue
        }
        return
      }
      runMediaCommand(el, c.effect)
      applied.current++
    }
  }, [commands, epoch, mediaBase, urls, nodes])

  if (!nodes.length) return null
  const toggle = (el: HTMLMediaElement | null) => {
    if (!el) return
    if (el.paused)
      void el.play().catch(() => setError('无法播放该媒体，请检查资源或浏览器编码支持。'))
    else el.pause()
  }
  const ref = (id: string) => {
    let callback = refs.current.get(id)
    if (!callback) {
      callback = (element: HTMLMediaElement | null) => {
        if (element) els.current.set(id, element)
        else {
          const previous = els.current.get(id)
          previous?.pause()
          previous?.removeAttribute('src')
          previous?.load()
          els.current.delete(id)
        }
      }
      refs.current.set(id, callback)
    }
    return callback
  }
  return (
    <>
      {error && (
        <p
          role="alert"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 20,
            padding: '8px 12px',
            background: 'var(--surface)',
            color: 'var(--viewer-error)',
          }}
        >
          {error}
        </p>
      )}
      {nodes.map((n) => {
        const media = urls[n.sourceId]
        if (!media) return null
        const style: React.CSSProperties = {
          position: 'absolute',
          left: n.box.x * k,
          top: n.box.y * k,
          width: n.box.w * k,
          height: n.box.h * k,
          cursor: interactive ? 'pointer' : undefined,
          pointerEvents: interactive ? undefined : 'none',
        }
        const isPlaying = !!playing[n.sourceId]
        const onPlay = () => setPlaying((p) => ({ ...p, [n.sourceId]: true }))
        const onPause = () => setPlaying((p) => ({ ...p, [n.sourceId]: false }))
        if (media.kind === 'video') {
          return (
            <video
              key={n.sourceId}
              ref={ref(n.sourceId)}
              src={media.dataUrl}
              style={style}
              onError={() => setError('无法播放该视频：资源无法读取或当前浏览器不支持其编码。')}
              playsInline
              muted={muted}
              onClick={(e) => {
                e.stopPropagation()
                toggle(e.currentTarget)
              }}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onPause}
            />
          )
        }
        // Audio: the poster frame is drawn by the canvas; overlay a transparent click layer + play badge
        return (
          <div
            key={n.sourceId}
            style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={(e) => {
              e.stopPropagation()
              toggle(els.current.get(n.sourceId) ?? null)
            }}
          >
            <audio
              ref={ref(n.sourceId)}
              src={media.dataUrl}
              muted={muted}
              onError={() => setError('无法播放该音频：资源无法读取或当前浏览器不支持其编码。')}
              onPlay={onPlay}
              onPause={onPause}
              onEnded={onPause}
            />
            <span
              style={{
                fontSize: Math.min(n.box.w, n.box.h) * k * 0.4,
                lineHeight: 1,
                opacity: 0.85,
              }}
            >
              {isPlaying ? '\u23F8' : '\u25B6'}
            </span>
          </div>
        )
      })}
    </>
  )
}

/** OOXML media call semantics: playFrom(0.0) restarts, togglePause flips, stop rewinds. */
export function runMediaCommand(el: HTMLMediaElement, effect: MediaCommand['effect']): void {
  switch (effect) {
    case 'mediaPlay':
      el.currentTime = 0
      void el.play().catch(() => {})
      break
    case 'mediaPause':
      if (el.paused) void el.play().catch(() => {})
      else el.pause()
      break
    case 'mediaStop':
      el.pause()
      el.currentTime = 0
      break
  }
}
