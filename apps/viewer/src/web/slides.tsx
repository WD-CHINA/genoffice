import React, { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { SlideThumb } from '@genoffice/viewer-renderers/slides/renderer/SlideThumb'
import { PreviewMediaLayer } from '@genoffice/viewer-renderers/slides/renderer/components/PreviewMediaLayer'
import {
  createImageLoader,
  type ApplyImages,
} from '@genoffice/viewer-renderers/slides/renderer/image-loader'
import { LocaleProvider } from '@genoffice/viewer-renderers/slides/renderer/i18n/locale'
import type { SlidesDataSource } from '@genoffice/viewer-renderers/slides/renderer/data-source'
import '@genoffice/viewer-renderers/slides/renderer/styles.css'
import { hitLink } from '@genoffice/viewer-renderers/slides/renderer/preview-links'
import { ToolbarIcon } from './toolbar-icon'
import { ViewerBar } from './viewer-bar'
import { createPptxSession, type PptxDeck } from './pptx-session'
import { readViewerUi } from './ui-options'
import { createViewerTiming } from './performance'
import {
  ControlButton,
  FitControls,
  PageControl,
  ToolbarMore,
  ZoomControl,
  contentArea,
} from './viewer-controls'

const showSidebar = readViewerUi(new URLSearchParams(location.search)).showSidebar
const SlideShowView = lazy(() =>
  import('./viewer-slideshow').then((module) => ({
    default: module.ViewerSlideShow,
  })),
)

function imageUrls(data: unknown, urls = new Set<string>()) {
  if (typeof data === 'string' && data.startsWith('data:image/')) urls.add(data)
  else if (Array.isArray(data)) for (const value of data) imageUrls(value, urls)
  else if (data && typeof data === 'object')
    for (const value of Object.values(data)) imageUrls(value, urls)
  return urls
}

/** Sidebar raster width (px): it draws at 126, so 2x keeps the thumb crisp on HiDPI. */
const THUMB_PX = 252

/** mime of a data url descriptor, so a blob/object url can be typed after it */
function mimeOf(dataUrl: string) {
  const start = dataUrl.indexOf('data:') + 5
  return (
    dataUrl.slice(start, Math.max(dataUrl.indexOf(';', start), start)) || 'application/octet-stream'
  )
}

/**
 * First frame as a small still raster. The sidebar renders every slide at once and
 * a browser decodes all frames of an animated GIF as soon as it paints one, so the
 * strip used to hold a full decode of every animated picture in the deck at the
 * same time (10 x 18 MB GIFs in a course deck = ~1.4 GB, enough to OOM-kill the
 * tab). Only the slide on screen keeps the animated original.
 */
function needsStillRaster(img: HTMLImageElement, mime: string) {
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  return mime === 'image/gif' || w > THUMB_PX || h > THUMB_PX
}

async function stillRaster(img: HTMLImageElement, mime: string): Promise<HTMLImageElement | null> {
  if (!needsStillRaster(img, mime)) return null
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * Math.min(1, THUMB_PX / Math.max(w, h)))
    canvas.height = Math.round(h * Math.min(1, THUMB_PX / Math.max(w, h)))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const src = canvas.toDataURL('image/png')
    return await new Promise<HTMLImageElement | null>((resolve) => {
      const out = new Image()
      out.onload = () => resolve(out)
      out.onerror = () => resolve(null)
      out.src = src
    })
  } catch {
    return null
  }
}
export function Slides({ src }: { src: string }) {
  const [deck, setDeck] = useState<any>(null),
    /** full-resolution pictures, kept only for the slide on screen (its +/-) */
    [images, setImages] = useState(new Map<string, HTMLImageElement>()),
    /** thumbnail strip: still rasters keyed by the picture's data url */
    [thumbs, setThumbs] = useState(new Map<string, HTMLImageElement>()),
    [page, setPage] = useState(0),
    [show, setShow] = useState(false),
    [error, setError] = useState(''),
    [width, setWidth] = useState(960)
  const [zoom, setZoom] = useState(1),
    [fit, setFit] = useState<'width' | 'page' | null>('page'),
    [retry, setRetry] = useState(0)
  const [visibleThumbs, setVisibleThumbs] = useState(new Set<number>())
  const [thumbsOpen, setThumbsOpen] = useState(false)
  const thumbToggle = useRef<HTMLButtonElement>(null)
  const thumbPane = useRef<HTMLElement>(null)
  const thumbnailDemand = useRef(new Set<string>())
  const requestImages = useRef<(keys: Iterable<string>) => void>(() => {})
  const timing = useRef<ReturnType<typeof createViewerTiming> | null>(null)
  const pane = useRef<HTMLDivElement>(null),
    visited = useRef<number[]>([]),
    faces = useRef(new Map<string, FontFace>()),
    pptx = useRef<ReturnType<typeof createPptxSession> | null>(null),
    /** per-slide picture keys, so navigation can ask for just that slide's images */
    slideUrls = useRef<string[][]>([]),
    allUrls = useRef<string[]>([]),
    /** keys whose full-resolution decode is currently wanted */
    demand = useRef(new Set<string>()),
    thumbsStarted = useRef(new Set<string>()),
    /** render-tree key → what the image loader actually decodes (a blob url for big parts) */
    sourceOf = useRef(new Map<string, string>()),
    keyOf = useRef(new Map<string, string>()),
    thumbsMime = useRef(new Map<string, string>()),
    loaderRef = useRef<ReturnType<typeof createImageLoader> | null>(null)
  useEffect(() => {
    if (!deck || !pane.current) return
    const element = pane.current
    const slide = deck.slides[page]
    const resize = () => {
      const area = contentArea(element)
      setWidth(
        fit
          ? Math.max(
              100,
              fit === 'width'
                ? area.width
                : Math.min(area.width, (area.height * slide.widthPx) / slide.heightPx),
            )
          : slide.widthPx * zoom,
      )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [deck, page, fit, zoom])
  /** Ask the loader for the slide on screen and drop the rest, so a long deck
   *  never keeps a full decode of every picture it contains. */
  useEffect(() => {
    const loader = loaderRef.current
    const slides = slideUrls.current
    if (!loader || !slides.length) return
    const wanted = new Set<string>(show ? allUrls.current : [])
    if (!show)
      for (const index of [page, page + 1, page - 1])
        for (const url of slides[index] || []) wanted.add(url)
    demand.current = wanted
    requestImages.current(wanted)
    loader.release(
      [...allUrls.current]
        .filter((key) => !wanted.has(key) && !thumbnailDemand.current.has(key))
        .map((key) => sourceOf.current.get(key) ?? key),
    )
    // re-attach pictures the loader already decoded (a jump back to a visited slide
    // must not decode again), and let go of the ones out of the window
    setImages((old) => {
      let next = old
      for (const key of wanted) {
        const img = loader.image(sourceOf.current.get(key) ?? key)
        if (img && !next.has(key)) next = new Map([...next, [key, img]])
      }
      if ([...next.keys()].some((key) => !wanted.has(key)))
        next = new Map([...next].filter(([key]) => wanted.has(key)))
      return next
    })
  }, [deck, page, show])
  useEffect(() => {
    const root = thumbPane.current
    if (!deck || !root || !showSidebar || !thumbsOpen) {
      setVisibleThumbs(new Set())
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleThumbs((old) => {
          const next = new Set(old)
          for (const entry of entries) {
            const index = Number((entry.target as HTMLElement).dataset.slideIndex)
            if (entry.isIntersecting) next.add(index)
            else next.delete(index)
          }
          return next
        })
      },
      { root, rootMargin: '160px 0px' },
    )
    for (const button of root.querySelectorAll('[data-slide-index]')) observer.observe(button)
    return () => observer.disconnect()
  }, [deck, thumbsOpen])
  useEffect(() => {
    if (!thumbsOpen) return
    const close = (event: PointerEvent) => {
      const target = event.target as Node
      if (!thumbPane.current?.contains(target) && !thumbToggle.current?.contains(target))
        setThumbsOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setThumbsOpen(false)
      thumbToggle.current?.focus()
    }
    const selected = thumbPane.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')
    selected?.scrollIntoView({ block: 'nearest' })
    selected?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
    }
  }, [thumbsOpen])
  useEffect(() => {
    const wanted = new Set<string>()
    if (showSidebar && thumbsOpen)
      for (const index of visibleThumbs)
        for (const key of slideUrls.current[index] || [])
          if (!thumbsStarted.current.has(key)) wanted.add(key)
    thumbnailDemand.current = wanted
    requestImages.current(wanted)
  }, [deck, visibleThumbs, thumbsOpen])
  useEffect(() => {
    if (!deck) return
    timing.current?.onceAfterPaint('firstCanvas')
    if ((slideUrls.current[page] || []).every((key) => images.has(key)))
      timing.current?.onceAfterPaint('currentPageImagesReady')
  }, [deck, images, page])
  useEffect(() => {
    let cancelled = false
    const revoked: string[] = []
    const stageTiming = createViewerTiming('pptx')
    timing.current = stageTiming
    setError('')
    setDeck(null)
    setVisibleThumbs(new Set())
    slideUrls.current = []
    allUrls.current = []
    sourceOf.current.clear()
    keyOf.current.clear()
    thumbsMime.current.clear()
    thumbsStarted.current.clear()
    thumbnailDemand.current.clear()
    demand.current.clear()
    setThumbs(new Map())
    setImages(new Map())
    const applyImages: ApplyImages = (entries) => {
      if (cancelled) return
      // only the demanded keys stay at full size; the rest only feed a thumbnail
      const full: Array<readonly [string, HTMLImageElement]> = []
      for (const [url, img] of entries) {
        const key = keyOf.current.get(url) ?? url
        if (demand.current.has(key)) full.push([key, img])
      }
      if (full.length) setImages((old) => new Map([...old, ...full]))
      for (const [url, img] of entries) {
        const key = keyOf.current.get(url) ?? url
        if (thumbsStarted.current.has(key)) continue
        thumbsStarted.current.add(key)
        void stillRaster(img, thumbsMime.current.get(key) || 'image/png').then((raster) => {
          if (cancelled) return
          if (raster || !needsStillRaster(img, thumbsMime.current.get(key) || 'image/png'))
            setThumbs((old) => new Map([...old, [key, raster || img]]))
          if (!demand.current.has(key)) {
            loader.release([url])
            thumbLoader.release([url])
          }
        })
      }
    }
    const loader = createImageLoader(applyImages)
    const thumbLoader = createImageLoader(applyImages, 4, 100, 1)
    loaderRef.current = loader
    const session = createPptxSession()
    pptx.current = session
    const parts = new Map<string, string>()
    const queued = new Set<string>()
    const active = new Set<string>()
    let inFlight = 0
    const pump = () => {
      while (!cancelled && inFlight < 2 && queued.size) {
        const key =
          [...demand.current].find((key) => queued.has(key)) || queued.values().next().value!
        queued.delete(key)
        if (!demand.current.has(key) && !thumbnailDemand.current.has(key)) continue
        active.add(key)
        inFlight++
        void (async () => {
          let url = sourceOf.current.get(key)
          if (!url) {
            const ref = parts.get(key)
            if (ref) {
              const bytes = await session.bytes(ref)
              if (cancelled || !bytes) return
              url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(key) }))
              revoked.push(url)
            } else url = key
            sourceOf.current.set(key, url)
            keyOf.current.set(url, key)
          }
          if (!cancelled) {
            if (demand.current.has(key)) loader.load([url])
            else if (thumbnailDemand.current.has(key)) thumbLoader.load([url])
          }
        })()
          .catch((error) => {
            if (!cancelled) setError(error instanceof Error ? error.message : String(error))
          })
          .finally(() => {
            active.delete(key)
            inFlight--
            pump()
          })
      }
    }
    requestImages.current = (keys) => {
      for (const key of keys) if (!active.has(key)) queued.add(key)
      pump()
    }
    void (async () => {
      const file = await fetch(src)
      if (!file.ok) throw new Error('无法读取演示文稿')
      const bytes = await file.arrayBuffer()
      stageTiming.mark('fileRead')
      let data: PptxDeck = await session.open(bytes)
      stageTiming.mark('workerOpen')
      stageTiming.worker(data.timings)
      ;(window as any).__genofficeDocFontsSynced = false
      const loaded = new Set<string>()
      const fontKey = (font: { family: string; bold: boolean; italic: boolean }) =>
        `${font.family}:${!!font.bold}:${!!font.italic}`
      await Promise.all(
        data.fonts.map(async (font) => {
          for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
            try {
              let face = faces.current.get(font.id)
              if (!face) {
                const source = font.url ? `url(${font.url})` : await session.font(font.id)
                if (!source) throw new Error('字体下载失败')
                face = new FontFace(font.family, source, {
                  weight: font.bold ? '700' : '400',
                  style: font.italic ? 'italic' : 'normal',
                })
                await face.load()
                if (cancelled) return
                document.fonts.add(face)
                for (const name of font.also || [])
                  document.fonts.add(
                    new FontFace(name, source, {
                      weight: font.bold ? '700' : '400',
                      style: font.italic ? 'italic' : 'normal',
                    }),
                  )
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
      stageTiming.mark('fontsReady')
      const ctx = document.createElement('canvas').getContext('2d')!
      const privateFamilies = new Set(data.fonts.map((font) => font.family))
      const privateVariants = new Set(data.fonts.map(fontKey))
      for (let round = 0; round < 6 && !cancelled; round++) {
        const widths: Record<string, number> = {}
        for (const item of data.measurements) {
          if (
            privateFamilies.has(item.family) &&
            (privateVariants.has(fontKey(item))
              ? !loaded.has(fontKey(item))
              : !data.fonts.some(
                  (font) => font.family === item.family && loaded.has(fontKey(font)),
                ))
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
        if (Object.keys(widths).length) data = await session.measure(widths)
        else break
        if (!data.measurements.length) break
      }
      if (cancelled) return
      stageTiming.mark('layoutStable')
      stageTiming.worker(data.timings)
      if (data.measurements.length || data.fallbacks.length)
        setError(
          data.fallbacks.length
            ? `以下字体未包含在字体包中，已使用度量替代：${data.fallbacks.join('、')}`
            : '字体加载或重新测量尚未完成，当前使用原项目的字体回退，可重试。',
        )
      ;(window as any).__genofficeDocFontsSynced = true
      document.fonts.dispatchEvent(new Event('loadingdone'))
      // Index descriptors without fetching their bytes. Current/adjacent pages and
      // visible thumbnails request their pictures after the deck is displayed.
      slideUrls.current = data.slides.map((slide: unknown) => [...imageUrls(slide)])
      const keys = [...new Set(slideUrls.current.flat())]
      // A render tree carries a descriptor (the part's head) for anything big; hand the
      // page the real bytes as a blob so nothing has to travel as base64.
      for (const [key, ref] of data.media || []) parts.set(key, ref)
      for (const key of keys) {
        thumbsMime.current.set(key, mimeOf(key))
        if (!parts.has(key)) {
          sourceOf.current.set(key, key)
          keyOf.current.set(key, key)
        }
      }
      allUrls.current = keys
      for (const key of keys) thumbsStarted.current.delete(key)
      setDeck(data)
    })().catch((e) => {
      if (!cancelled) setError(e.message)
    })
    return () => {
      cancelled = true
      queued.clear()
      requestImages.current = () => {}
      loaderRef.current = null
      session.close()
      loader.dispose()
      thumbLoader.dispose()
      // revoke the blob urls built from part bytes; the key maps only hold short strings
      // and are rebuilt by the next run (the effect re-runs on retry, unmount drops them)
      for (const url of revoked) URL.revokeObjectURL(url)
    }
  }, [src, retry])
  if (!deck)
    return (
      <p className="viewer-status" role={error ? 'alert' : undefined}>
        {error || '正在加载字体和幻灯片…'}
      </p>
    )
  const source: SlidesDataSource = {
    getTransition: async (i) => deck.playback[i].transition,
    getAnimations: async (i) => deck.playback[i].animations,
    getShapeKeys: async (i) => deck.playback[i].keys,
    getSlideLinks: async (i) => deck.playback[i].links,
    getRunLinks: async (i) => deck.playback[i].runLinks,
    getMediaData: async (i, id) => {
      const media = await pptx.current?.media(i, id)
      if (!media) return null
      return { kind: media.kind === 'audio' ? 'audio' : 'video', dataUrl: media.dataUrl }
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
  const changeZoom = (direction: number) => {
    setFit(null)
    setZoom(Math.max(0.25, Math.min(4, width / deck.slides[page].widthPx + direction * 0.1)))
  }
  return (
    <LocaleProvider initial="zh">
      <div className="viewer-preview viewer-slides">
        <ViewerBar floating label="PPT 控制栏">
          <PageControl
            format="PPT"
            selectable={false}
            current={page + 1}
            total={deck.slides.length}
            onChange={(number) => navigate(number - 1)}
          />
          <ZoomControl value={width / deck.slides[page].widthPx} onZoom={changeZoom} />
          <ToolbarMore zoom={{ value: width / deck.slides[page].widthPx, onZoom: changeZoom }}>
            <FitControls fit={fit} onFit={setFit} />
          </ToolbarMore>
          <ControlButton
            icon="play"
            label="开始放映"
            className="viewer-primary-action"
            onClick={start}
          >
            开始放映
          </ControlButton>
        </ViewerBar>
        {error && (
          <p className="viewer-error" role="alert">
            {error}
            <button onClick={() => setRetry((value) => value + 1)}>重试字体</button>
          </p>
        )}
        <div className="viewer-deck">
          {showSidebar && (
            <button
              ref={thumbToggle}
              type="button"
              className="viewer-thumbs-toggle"
              aria-label="幻灯片预览"
              title="幻灯片预览"
              aria-expanded={thumbsOpen}
              aria-controls="viewer-slide-previews"
              onClick={() => setThumbsOpen((value) => !value)}
            >
              <ToolbarIcon name="thumbs" />
              <span>预览</span>
              <span className="viewer-thumb-total">{deck.slides.length}</span>
            </button>
          )}
          {showSidebar && thumbsOpen && (
            <aside
              className="viewer-thumbs"
              id="viewer-slide-previews"
              aria-label="幻灯片预览图"
              ref={thumbPane}
            >
              <div className="viewer-thumbs-heading">
                <span>幻灯片预览</span>
                <ControlButton
                  icon="close"
                  label="关闭预览图"
                  onClick={() => {
                    setThumbsOpen(false)
                    thumbToggle.current?.focus()
                  }}
                />
              </div>
              {deck.slides.map((slide: any, i: number) => (
                <button
                  key={i}
                  aria-label={`第 ${i + 1} 页`}
                  aria-current={i === page}
                  data-slide-index={i}
                  onClick={() => {
                    navigate(i)
                    setThumbsOpen(false)
                    thumbToggle.current?.focus()
                  }}
                >
                  <div style={{ width: 126, height: (126 * slide.heightPx) / slide.widthPx }}>
                    {visibleThumbs.has(i) && (
                      <SlideThumb slide={slide} images={thumbs} width={126} />
                    )}
                  </div>
                  <span>{i + 1}</span>
                </button>
              ))}
            </aside>
          )}
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
                  key={`${src}-${page}`}
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
          <Suspense
            fallback={
              <p className="viewer-status" role="status">
                正在准备放映…
              </p>
            }
          >
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
          </Suspense>
        )}
      </div>
    </LocaleProvider>
  )
}
