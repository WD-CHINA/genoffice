import React, { useEffect, useRef, useState } from 'react'
import { SlideThumb } from '@genoffice/viewer-renderers/slides/renderer/SlideThumb'
import { PreviewMediaLayer } from '@genoffice/viewer-renderers/slides/renderer/components/PreviewMediaLayer'
import { SlideShowView } from '@genoffice/viewer-renderers/slides/renderer/components/SlideShowView'
import { createImageLoader } from '@genoffice/viewer-renderers/slides/renderer/image-loader'
import { LocaleProvider } from '@genoffice/viewer-renderers/slides/renderer/i18n/locale'
import type { SlidesDataSource } from '@genoffice/viewer-renderers/slides/renderer/data-source'
import '@genoffice/viewer-renderers/slides/renderer/styles.css'
import { hitLink } from '@genoffice/viewer-renderers/slides/renderer/preview-links'
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
  const [zoom, setZoom] = useState(1),
    [fit, setFit] = useState<'width' | 'page' | null>('page'),
    [retry, setRetry] = useState(0)
  const pane = useRef<HTMLDivElement>(null),
    visited = useRef<number[]>([]),
    faces = useRef(new Map<string, FontFace>())
  useEffect(() => {
    if (!deck || !pane.current) return
    const element = pane.current
    const slide = deck.slides[page]
    const resize = () =>
      setWidth(
        fit
          ? Math.max(
              100,
              fit === 'width'
                ? element.clientWidth - 48
                : Math.min(
                    element.clientWidth - 48,
                    ((element.clientHeight - 48) * slide.widthPx) / slide.heightPx,
                  ),
            )
          : slide.widthPx * zoom,
      )
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [deck, page, fit, zoom])
  useEffect(() => {
    let cancelled = false
    setError('')
    const loader = createImageLoader((entries) => {
      if (!cancelled) setImages((old) => new Map([...old, ...entries]))
    })
    void (async () => {
      let data = await api(`view-sessions/${session}/slides`)
      ;(window as any).__genofficeDocFontsSynced = false
      const loaded = new Set<string>()
      const fontKey = (font: any) => `${font.family}:${!!font.bold}:${!!font.italic}`
      await Promise.all(
        data.fonts.map(async (font: any) => {
          for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
            try {
              let face = faces.current.get(font.id)
              if (!face) {
                const response = await fetch(
                  `/api/view-sessions/${session}/fonts/${encodeURIComponent(font.id)}`,
                  { signal: AbortSignal.timeout(15_000) },
                )
                if (!response.ok) throw new Error('字体下载失败')
                face = new FontFace(font.family, await response.arrayBuffer(), {
                  weight: font.bold ? '700' : '400',
                  style: font.italic ? 'italic' : 'normal',
                })
                await face.load()
                if (cancelled) return
                document.fonts.add(face)
                faces.current.set(font.id, face)
              }
              loaded.add(fontKey(font))
              break
            } catch {
              if (attempt < 2)
                await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
            }
          }
        }),
      )
      await document.fonts.ready
      const ctx = document.createElement('canvas').getContext('2d')!
      const privateFamilies = new Set(data.fonts.map((f: any) => f.family))
      const privateVariants = new Set(data.fonts.map(fontKey))
      for (let round = 0; round < 6 && !cancelled; round++) {
        const widths: Record<string, number> = {}
        for (const item of data.measurements) {
          if (
            privateFamilies.has(item.family) &&
            (privateVariants.has(fontKey(item))
              ? !loaded.has(fontKey(item))
              : !data.fonts.some((f: any) => f.family === item.family && loaded.has(fontKey(f))))
          )
            continue
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
        else break
        if (!data.measurements.length) break
      }
      if (cancelled) return
      if (data.measurements.length)
        setError('字体加载或重新测量尚未完成，当前使用原项目的字体回退，可重试。')
      ;(window as any).__genofficeDocFontsSynced = true
      document.fonts.dispatchEvent(new Event('loadingdone'))
      loader.load(imageUrls(data.slides))
      setDeck(data)
    })().catch((e) => {
      if (!cancelled) setError(e.message)
    })
    return () => {
      cancelled = true
      loader.dispose()
    }
  }, [session, retry])
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
  const navigate = (index: number) => {
    const next = Math.max(0, Math.min(deck.slides.length - 1, index))
    if (!Number.isInteger(next)) return
    visited.current.push(page)
    setPage(next)
  }
  const targetAt = (event: React.MouseEvent<HTMLElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return hitLink(
      deck.slides[page].nodes,
      ((event.clientX - bounds.left) * deck.slides[page].widthPx) / width,
      ((event.clientY - bounds.top) * deck.slides[page].widthPx) / width,
      new Map(deck.playback[page].links.map((link: any) => [link.sourceId, link.target])),
      new Map(
        deck.playback[page].runLinks.map((link: any) => [
          `${link.sourceId}:${link.paraIndex}:${link.runIndex}`,
          link.target,
        ]),
      ),
    )
  }
  const follow = (event: React.MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('button,audio,video')) return
    const target = targetAt(event)
    if (!target) return
    if (target.kind === 'slide') navigate(target.slideIndex)
    else if (target.kind === 'url' && /^https?:|^mailto:/i.test(target.url))
      window.open(target.url, '_blank', 'noopener,noreferrer')
    else if (target.kind === 'action') {
      const next = {
        nextslide: page + 1,
        previousslide: page - 1,
        firstslide: 0,
        lastslide: deck.slides.length - 1,
        lastslideviewed: visited.current.pop() ?? page,
        endshow: page,
      }[target.action]
      navigate(next)
    }
  }
  const start = () => {
    void document.documentElement.requestFullscreen?.().catch(() => {})
    setShow(true)
  }
  return (
    <LocaleProvider initial="zh">
      <div className="viewer-preview">
        <header className="viewer-bar">
          <button disabled={!page} onClick={() => navigate(page - 1)}>
            上一页
          </button>
          <span>
            {page + 1} / {deck.slides.length}
          </span>
          <button disabled={page === deck.slides.length - 1} onClick={() => navigate(page + 1)}>
            下一页
          </button>
          <label>
            跳页
            <input
              aria-label="PPT 页码"
              type="number"
              min="1"
              max={deck.slides.length}
              value={page + 1}
              onChange={(e) => navigate(Number(e.target.value) - 1)}
            />
          </label>
          <button
            onClick={() => {
              setFit(null)
              setZoom(Math.max(0.25, width / deck.slides[page].widthPx - 0.1))
            }}
          >
            缩小
          </button>
          <button
            onClick={() => {
              setFit(null)
              setZoom(Math.min(4, width / deck.slides[page].widthPx + 0.1))
            }}
          >
            放大
          </button>
          <button onClick={() => setFit('width')}>适合宽度</button>
          <button onClick={() => setFit('page')}>适合页面</button>
          <button onClick={start}>开始放映</button>
        </header>
        {error && (
          <p className="viewer-error" role="alert">
            {error}
            <button onClick={() => setRetry((value) => value + 1)}>重试字体</button>
          </p>
        )}
        <div className="viewer-deck">
          <aside className="viewer-thumbs">
            {deck.slides.map((slide: any, i: number) => (
              <button
                key={i}
                aria-label={`第 ${i + 1} 页`}
                aria-current={i === page}
                onClick={() => navigate(i)}
              >
                <SlideThumb slide={slide} images={images} width={126} />
                <span>{i + 1}</span>
              </button>
            ))}
          </aside>
          <div ref={pane} className="viewer-slide">
            <div
              className="viewer-slide-stage"
              onClick={follow}
              onMouseMove={(event) => {
                event.currentTarget.style.cursor = targetAt(event) ? 'pointer' : ''
              }}
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
