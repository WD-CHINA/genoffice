/** The original slide canvas stays intact; playback uses its native DOM overlay. */
import React, { useEffect, useRef, useState } from 'react'
import type { PictureRenderNode, RenderSlide } from '@genoffice/pptx-render'
import type { SlidesDataSource } from '../data-source'

type Playback = { node: PictureRenderNode; kind: 'audio' | 'video'; dataUrl: string }
export function PreviewMediaLayer({
  slide,
  slideIndex,
  width,
  dataSource,
}: {
  slide: RenderSlide
  slideIndex: number
  width: number
  dataSource: SlidesDataSource
}) {
  const [playback, setPlayback] = useState<Playback | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState<string | null>(null)
  const generation = useRef(0)
  const player = useRef<HTMLMediaElement | null>(null)
  const k = width / slide.widthPx
  const nodes = slide.nodes.filter(
    (node): node is PictureRenderNode => node.type === 'picture' && !!node.media,
  )
  function close() {
    generation.current++
    setLoading(null)
    setPlayback(null)
    setError('')
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', escape)
    return () => {
      generation.current++
      window.removeEventListener('keydown', escape)
    }
  }, [])
  useEffect(() => {
    const element = player.current
    return () => {
      element?.pause()
      element?.removeAttribute('src')
      element?.load()
    }
  }, [playback?.node.sourceId])
  async function start(node: PictureRenderNode) {
    const token = ++generation.current
    setError('')
    setLoading(node.sourceId)
    try {
      const media = await dataSource.getMediaData(slideIndex, node.sourceId)
      if (token !== generation.current) return
      if (!media) throw new Error('文档中的媒体资源不存在或未嵌入。')
      setPlayback({ node, ...media })
    } catch (error) {
      if (token === generation.current)
        setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (token === generation.current) setLoading(null)
    }
  }
  const geometry = (node: PictureRenderNode): React.CSSProperties => ({
    position: 'absolute',
    left: node.box.x * k,
    top: node.box.y * k,
    width: node.box.w * k,
    height: node.box.h * k,
  })
  const onError = () => setError('无法播放该媒体：资源无法读取或当前浏览器不支持其编码。')
  return (
    <>
      {nodes.map((node) => (
        <button
          key={node.sourceId}
          type="button"
          aria-label={node.media === 'video' ? '播放视频' : '播放音频'}
          title={node.media === 'video' ? '播放视频' : '播放音频'}
          disabled={loading === node.sourceId}
          style={{
            ...geometry(node),
            border: 0,
            padding: 0,
            background: 'transparent',
            cursor: 'pointer',
          }}
          onClick={() => void start(node)}
        />
      ))}
      {playback && (
        <div
          key={playback.node.sourceId}
          style={{
            ...geometry(playback.node),
            height:
              playback.kind === 'video'
                ? playback.node.box.h * k
                : Math.max(playback.node.box.h * k, 40),
            zIndex: 20,
            background: playback.kind === 'video' ? '#000' : 'transparent',
            borderRadius: 4,
            overflow: 'hidden',
            boxShadow: '0 2px 12px rgba(0,0,0,.35)',
          }}
        >
          {playback.kind === 'video' ? (
            <video
              ref={(element) => {
                player.current = element
              }}
              src={playback.dataUrl}
              controls
              autoPlay
              playsInline
              onError={onError}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <audio
              ref={(element) => {
                player.current = element
              }}
              src={playback.dataUrl}
              controls
              autoPlay
              onError={onError}
              style={{ width: '100%' }}
            />
          )}
          <button
            onClick={close}
            aria-label="关闭媒体播放"
            title="关闭媒体播放"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 22,
              height: 22,
              lineHeight: '20px',
              padding: 0,
              border: 'none',
              borderRadius: '50%',
              background: 'rgba(0,0,0,.55)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            ×
          </button>
        </div>
      )}
      {error && (
        <p
          role="alert"
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            zIndex: 21,
            margin: 0,
            padding: '8px 12px',
            background: 'var(--surface)',
            color: 'var(--viewer-error)',
          }}
        >
          {error}
        </p>
      )}
    </>
  )
}
