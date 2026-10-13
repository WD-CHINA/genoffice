import React, { useEffect, useRef, useState } from 'react'
import { SlideThumb } from '@genoffice/viewer-renderers/slides/renderer/SlideThumb'
import { PreviewMediaLayer } from '@genoffice/viewer-renderers/slides/renderer/components/PreviewMediaLayer'
import { SlideShowView } from '@genoffice/viewer-renderers/slides/renderer/components/SlideShowView'
import { createImageLoader } from '@genoffice/viewer-renderers/slides/renderer/image-loader'
import { LocaleProvider } from '@genoffice/viewer-renderers/slides/renderer/i18n/locale'
import type { SlidesDataSource } from '@genoffice/viewer-renderers/slides/renderer/data-source'
import '@genoffice/viewer-renderers/slides/renderer/styles.css'
import { api, post } from './api'

function imageUrls(data: unknown, urls = new Set<string>()) {
  if (typeof data === 'string' && data.startsWith('data:image/')) urls.add(data)
  else if (Array.isArray(data)) for (const value of data) imageUrls(value, urls)
  else if (data && typeof data === 'object')
    for (const value of Object.values(data)) imageUrls(value, urls)
  return urls
}
export function Slides({ session }: { session: string }) {
  const [deck, setDeck] = useState<any>(null),
    [images, setImages] = useState(new Map<string, HTMLImageElement>()),
    [page, setPage] = useState(0),
    [show, setShow] = useState(false),
    [error, setError] = useState(''),
    [width, setWidth] = useState(960)
  const cancelled = useRef(false)
  useEffect(() => {
    cancelled.current = false
    const loader = createImageLoader((entries) => {
      if (!cancelled.current) setImages((old) => new Map([...old, ...entries]))
    })
    const resize = () => setWidth(Math.max(200, Math.min(960, window.innerWidth - 240)))
    resize()
    window.addEventListener('resize', resize)
    void (async () => {
      let data = await api(`view-sessions/${session}/slides`)
      ;(window as any).__genofficeDocFontsSynced = false
      const loaded = new Set<string>()
      await Promise.all(
        data.fonts.map(async (font: any) => {
          try {
            const response = await fetch(`/api/view-sessions/${session}/fonts/${font.id}`)
            if (!response.ok) return
            const face = new FontFace(font.family, await response.arrayBuffer(), {
              weight: font.bold ? '700' : '400',
              style: font.italic ? 'italic' : 'normal',
            })
            await face.load()
            document.fonts.add(face)
            loaded.add(font.family)
          } catch {
            /* Retain the original fallback and pending measurement. */
          }
        }),
      )
      await document.fonts.ready
      const ctx = document.createElement('canvas').getContext('2d')!
      const privateFamilies = new Set(data.fonts.map((f: any) => f.family))
      const widths: Record<string, number> = {}
      for (const item of data.measurements) {
        if (privateFamilies.has(item.family) && !loaded.has(item.family)) continue
        ctx.font =
          (item.italic ? 'italic ' : '') +
          (item.bold ? 'bold ' : '') +
          '100px "' +
          item.family +
          "\", 'PingFang SC', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic', sans-serif"
        widths[item.key] = ctx.measureText(item.text).width
      }
      if (Object.keys(widths).length)
        data = await post(`view-sessions/${session}/text-widths`, {
          revision: data.revision,
          batchId: data.batchId,
          widths,
        })
      if (cancelled.current) return
      if (data.measurements.length) setError('部分字体尚未就绪，当前使用原项目的字体回退。')
      ;(window as any).__genofficeDocFontsSynced = true
      document.fonts.dispatchEvent(new Event('loadingdone'))
      loader.load(imageUrls(data.slides))
      setDeck(data)
    })().catch((e) => {
      if (!cancelled.current) setError(e.message)
    })
    return () => {
      cancelled.current = true
      loader.dispose()
      window.removeEventListener('resize', resize)
    }
  }, [session])
  if (!deck) return <p role={error ? 'alert' : undefined}>{error || '正在加载字体和幻灯片…'}</p>
  const source: SlidesDataSource = {
    getTransition: async (i) => deck.playback[i].transition,
    getAnimations: async (i) => deck.playback[i].animations,
    getShapeKeys: async (i) => deck.playback[i].keys,
    getSlideLinks: async (i) => deck.playback[i].links,
    getRunLinks: async (i) => deck.playback[i].runLinks,
    getMediaData: async (i, id) => {
      const response = await fetch(
        `/api/view-sessions/${session}/media/${i}/${encodeURIComponent(id)}?metadata`,
      )
      if (response.status === 404) return null
      if (!response.ok) throw new Error('无法加载媒体资源，请重新打开文档后重试。')
      return response.json()
    },
  }
  const start = () => {
    void document.documentElement.requestFullscreen?.().catch(() => {})
    setShow(true)
  }
  return (
    <LocaleProvider initial="zh">
      <div className="viewer-preview">
        <header className="viewer-bar">
          <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span>
            {page + 1} / {deck.slides.length}
          </span>
          <button disabled={page === deck.slides.length - 1} onClick={() => setPage((p) => p + 1)}>
            下一页
          </button>
          <button onClick={start}>开始放映</button>
        </header>
        {error && (
          <p className="viewer-error" role="alert">
            {error}
          </p>
        )}
        <div className="viewer-deck">
          <aside className="viewer-thumbs">
            {deck.slides.map((slide: any, i: number) => (
              <button
                key={i}
                aria-label={`第 ${i + 1} 页`}
                aria-current={i === page}
                onClick={() => setPage(i)}
              >
                <SlideThumb slide={slide} images={images} width={126} />
                <span>{i + 1}</span>
              </button>
            ))}
          </aside>
          <div className="viewer-slide">
            <div
              className="viewer-slide-stage"
              style={{
                position: 'relative',
                width,
                height: (deck.slides[page].heightPx * width) / deck.slides[page].widthPx,
              }}
            >
              <SlideThumb slide={deck.slides[page]} images={images} width={width} />
              {!show && (
                <PreviewMediaLayer
                  key={`${session}-${page}`}
                  slide={deck.slides[page]}
                  slideIndex={page}
                  width={width}
                  dataSource={source}
                />
              )}
            </div>
          </div>
        </div>
        {show && (
          <SlideShowView
            slides={deck.slides}
            dataSource={source}
            images={images}
            startAt={page}
            onExit={(last) => {
              setPage(last)
              setShow(false)
            }}
          />
        )}
      </div>
    </LocaleProvider>
  )
}
