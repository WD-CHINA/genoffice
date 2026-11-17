import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { ToolbarIcon } from './toolbar-icon'
import { ViewerBar } from './viewer-bar'
import {
  ControlButton,
  FitControls,
  PageControl,
  ToolbarMore,
  ZoomControl,
  contentArea,
} from './viewer-controls'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { installReadableStreamAsyncIterator } from './readable-stream-compat'
import { PdfPage, useVisibleSet } from '@genoffice/viewer-renderers/pdf/renderer/PdfPage'
import { PdfThumb } from '@genoffice/viewer-renderers/pdf/renderer/PdfThumb'
import { FormLayer } from '@genoffice/viewer-renderers/pdf/renderer/FormLayer'
import { LinkLayer } from '@genoffice/viewer-renderers/pdf/renderer/LinkLayer'
import { buildFormCatalog } from '@genoffice/viewer-renderers/pdf/renderer/form-catalog'
import {
  probePageGeometry,
  type PageProbeFailure,
} from '@genoffice/viewer-renderers/pdf/renderer/page-probe'
import {
  DOC_OPTS,
  ZOOM_STEPS,
  MIN_SCALE,
  MAX_SCALE,
  NOTE_MARGIN_W,
  PAGE_GAP,
} from '@genoffice/viewer-renderers/pdf/renderer/view-config'
import {
  buildSearchIndex,
  searchInIndex,
  type SearchMatch,
} from '@genoffice/viewer-renderers/pdf/renderer/search'
import {
  OutlinePanel,
  type OutlineNode,
} from '@genoffice/viewer-renderers/pdf/renderer/OutlinePanel'
import { buildHeadingOutline } from '@genoffice/viewer-renderers/pdf/renderer/heading-outline'
import { loadSavedAnnots } from '@genoffice/viewer-renderers/pdf/renderer/annotation-catalog'
import {
  buildNoteThreads,
  type NoteThreadItem,
} from '@genoffice/viewer-renderers/pdf/renderer/note-threads'
import { NoteMarginColumn } from '@genoffice/viewer-renderers/pdf/renderer/NoteMargin'
import { DrawLayer, NOTE_FALLBACK_COLOR } from '@genoffice/viewer-renderers/pdf/renderer/DrawLayer'
import { pdfRectToCss, pdfToView } from '@genoffice/viewer-renderers/pdf/renderer/annotations'
import '@genoffice/viewer-renderers/pdf/renderer/styles.css'
import '@genoffice/ui/dropdown.css'
GlobalWorkerOptions.workerSrc = worker
installReadableStreamAsyncIterator()
const noop = () => {}
const labels: Record<string, string> = {
  noteAnonymous: '匿名',
  noteReply: '回复',
  noteClose: '关闭',
  noteAuthor: '作者',
  noteEmpty: '无正文',
  noteOpen: '查看批注',
  noteThread: '批注',
}
export function Pdf({ src }: { src: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [catalog, setCatalog] = useState<any>(null),
    [geoms, setGeoms] = useState<any[]>([]),
    [scale, setScale] = useState(1),
    [rotation, setRotation] = useState(0),
    [error, setError] = useState(''),
    [pageFailures, setPageFailures] = useState<Map<number, PageProbeFailure>>(new Map()),
    [warnings, setWarnings] = useState<Record<string, string>>({}),
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<SearchMatch[]>([]),
    [hit, setHit] = useState(0),
    [current, setCurrent] = useState(1),
    [sidebar, setSidebar] = useState<'thumbs' | 'outline' | null>(null),
    [outline, setOutline] = useState<OutlineNode[]>([]),
    [generated, setGenerated] = useState(false),
    [info, setInfo] = useState<any>(null),
    [showInfo, setShowInfo] = useState(false),
    [notes, setNotes] = useState<Map<number, NoteThreadItem[]>>(new Map()),
    [activeNote, setActiveNote] = useState<string | null>(null),
    [fit, setFit] = useState<'width' | 'page' | null>('page')
  const scroll = useRef<HTMLDivElement>(null),
    thumbScroll = useRef<HTMLDivElement>(null),
    index = useRef<Promise<any> | null>(null),
    loadingNotes = useRef(new Set<number>()),
    activeDocument = useRef<PDFDocumentProxy | null>(null),
    unreadablePages = useRef(new Set<number>())
  const visible = useVisibleSet(scroll, doc?.numPages || 0, '800px', !!doc)
  const thumbs = useVisibleSet(
    thumbScroll,
    doc?.numPages || 0,
    '200px',
    !!doc && sidebar === 'thumbs',
  )
  const renderState = useCallback(noop, [])
  const renderError = useCallback((document: PDFDocumentProxy, page: number, cause: unknown) => {
    if (activeDocument.current !== document) return
    unreadablePages.current.add(page)
    setPageFailures((old) =>
      new Map(old).set(page, {
        page,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
    )
  }, [])
  const scaleValue = useRef(scale)
  scaleValue.current = scale
  const fitAnchor = useRef<{ doc: PDFDocumentProxy; page: number; offset: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = fitAnchor.current
    fitAnchor.current = null
    const element = scroll.current
    const page = element?.querySelector<HTMLElement>(`[data-idx="${anchor?.page}"]`)
    if (anchor && anchor.doc === doc && element && page)
      element.scrollTop +=
        page.getBoundingClientRect().top -
        element.getBoundingClientRect().top +
        anchor.offset * scale
  }, [scale, doc])
  useEffect(() => {
    let stopped = false
    let passwordCancelled = false
    activeDocument.current = null
    unreadablePages.current = new Set()
    index.current = null
    loadingNotes.current = new Set()
    fitAnchor.current = null
    setDoc(null)
    setGeoms([])
    setCatalog(null)
    setInfo(null)
    setOutline([])
    setGenerated(false)
    setNotes(new Map())
    setActiveNote(null)
    setPageFailures(new Map())
    setWarnings({})
    setError('')
    setMatches([])
    setHit(0)
    setCurrent(1)
    setRotation(0)
    setShowInfo(false)
    if (scroll.current) scroll.current.scrollTop = 0
    const task = getDocument({ url: src, ...DOC_OPTS })
    task.onPassword = (update: (password: string) => void, reason: number) => {
      const value = window.prompt(reason === 2 ? 'PDF 密码不正确，请重试' : '请输入 PDF 打开密码')
      if (stopped) return
      if (value !== null) update(value)
      else {
        passwordCancelled = true
        setError('已取消密码输入')
        void task.destroy().catch(() => {})
      }
    }
    void task.promise
      .then(async (document) => {
        const cancelled = () => stopped || activeDocument.current !== document
        if (stopped) return
        activeDocument.current = document
        const probe = await probePageGeometry(document, cancelled)
        if (cancelled()) return
        unreadablePages.current = new Set(probe.failures.map((failure) => failure.page))
        setPageFailures(new Map(probe.failures.map((failure) => [failure.page, failure])))
        setGeoms(
          probe.pages.map((page) => ({
            pw: page.width,
            ph: page.height,
            rot: page.rotate,
            x0: page.origin[0],
            y0: page.origin[1],
            userUnit: page.userUnit,
          })),
        )
        // Publish readable pages before optional scans. Metadata, annotations and
        // bookmarks have independent failure boundaries and cannot hide the bitmap.
        setDoc(document)
        const warn = (feature: string, message: string) => {
          if (!cancelled()) setWarnings((old) => ({ ...old, [feature]: message }))
        }
        const options = {
          cancelled,
          skipPage: (page: number) => unreadablePages.current.has(page),
          onPageError: () => warn('forms', '部分页面的表单暂不可用，仍可阅读页面内容。'),
        }
        const forms = async () => {
          try {
            const value = await buildFormCatalog(document, options)
            if (!cancelled()) setCatalog(value)
          } catch {
            warn('forms', '表单暂不可用，仍可阅读页面内容。')
          }
        }
        const metadata = async () => {
          try {
            const value = await document.getMetadata()
            if (!cancelled()) setInfo(value)
          } catch {
            warn('metadata', '文档信息暂不可用，仍可继续阅读。')
          }
        }
        const outline = async () => {
          let embedded: Awaited<ReturnType<PDFDocumentProxy['getOutline']>> | null = null
          try {
            embedded = await document.getOutline()
          } catch {
            warn('outline', '文档书签暂不可用，正在尝试识别标题目录。')
          }
          if (cancelled()) return
          if (embedded?.length) {
            setOutline(embedded as OutlineNode[])
            setGenerated(false)
            return
          }
          try {
            const tree = await buildHeadingOutline(document, cancelled, {
              ...options,
              onPageError: () => warn('outline', '部分页面的文字无法读取，目录可能不完整。'),
            })
            if (!cancelled()) {
              setOutline(tree || [])
              setGenerated(true)
            }
          } catch {
            warn('outline', '目录暂不可用，可使用页码继续阅读。')
          }
        }
        await Promise.all([forms(), metadata(), outline()])
      })
      .catch((cause) => {
        if (!stopped && !passwordCancelled)
          setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      stopped = true
      activeDocument.current = null
      void task.destroy().catch(() => {})
    }
  }, [src])

  useEffect(() => {
    if (!doc) return
    let cancelled = false
    const pending = loadingNotes.current
    const inflight = new Set<number>()
    for (const page of visible.visible) {
      if (pending.has(page) || unreadablePages.current.has(page + 1)) continue
      pending.add(page)
      inflight.add(page)
      void loadSavedAnnots(doc, page)
        .then((value) => {
          inflight.delete(page)
          if (cancelled) {
            pending.delete(page)
            return
          }
          setNotes((old) => new Map(old).set(page, buildNoteThreads(value.notes, [])))
        })
        .catch(() => {
          inflight.delete(page)
          pending.delete(page)
        })
    }
    return () => {
      cancelled = true
      for (const page of inflight) pending.delete(page)
    }
  }, [doc, visible.visible])
  function goPage(value: number) {
    const page = Math.max(1, Math.min(doc?.numPages || 1, value))
    scroll.current?.querySelector(`[data-idx="${page - 1}"]`)?.scrollIntoView({ block: 'start' })
    setCurrent(page)
  }
  async function goToDest(dest: any) {
    if (!doc) return
    try {
      const value = typeof dest === 'string' ? await doc.getDestination(dest) : dest
      if (!Array.isArray(value) || !value.length) return
      const page = typeof value[0] === 'number' ? value[0] : await doc.getPageIndex(value[0])
      if (activeDocument.current !== doc) return
      if (Number.isInteger(page)) goPage(page + 1)
    } catch {
      /* A corrupt link does not interrupt reading. */
    }
  }
  function track() {
    const element = scroll.current
    if (!element) return
    const top = element.getBoundingClientRect().top
    let best = 1,
      distance = Infinity
    for (const page of element.querySelectorAll<HTMLElement>('[data-idx]')) {
      const delta = Math.abs(page.getBoundingClientRect().top - top)
      if (delta < distance) {
        distance = delta
        best = Number(page.dataset.idx) + 1
      }
    }
    setCurrent(best)
  }
  useEffect(() => {
    if (!fit || !scroll.current || !geoms.length) return
    const element = scroll.current
    const update = () => {
      const area = contentArea(element)
      const geom = geoms[current - 1] || geoms[0],
        odd = (geom.rot + rotation) % 180 !== 0,
        w = odd ? geom.ph : geom.pw,
        h = odd ? geom.pw : geom.ph
      const nextScale = Math.max(
        MIN_SCALE,
        Math.min(
          MAX_SCALE,
          fit === 'width' ? area.width / w : Math.min(area.width / w, area.height / h),
        ),
      )
      if (Math.abs(nextScale - scaleValue.current) < 0.0001) return
      const page = element.querySelector<HTMLElement>(`[data-idx="${current - 1}"]`)
      if (doc && page)
        fitAnchor.current = {
          doc,
          page: current - 1,
          offset:
            (element.getBoundingClientRect().top - page.getBoundingClientRect().top) /
            scaleValue.current,
        }
      setScale(nextScale)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [fit, geoms, current, rotation, sidebar, doc])
  async function search() {
    const document = doc
    if (!document) return
    const cancelled = () => activeDocument.current !== document
    try {
      index.current ??= buildSearchIndex(document, {
        cancelled,
        skipPage: (page) => unreadablePages.current.has(page),
        onPageError: () => {
          if (!cancelled())
            setWarnings((old) => ({
              ...old,
              search: '部分页面的文字无法读取，搜索结果可能不完整。',
            }))
        },
      })
      const found = searchInIndex(await index.current, query)
      if (cancelled()) return
      setMatches(found)
      setHit(0)
      if (found.length) goPage(found[0].pageIndex + 1)
    } catch (cause) {
      if (!cancelled()) setWarnings((old) => ({ ...old, search: '搜索暂不可用，仍可继续阅读。' }))
    }
  }

  function step(delta: number) {
    if (!matches.length) return
    const next = (hit + delta + matches.length) % matches.length
    setHit(next)
    goPage(matches[next].pageIndex + 1)
  }
  const zoom = (direction: number) => {
    setFit(null)
    setScale((value) =>
      direction > 0
        ? (ZOOM_STEPS.find((s) => s > value + 0.001) ?? MAX_SCALE)
        : ([...ZOOM_STEPS].reverse().find((s) => s < value - 0.001) ?? MIN_SCALE),
    )
  }
  return (
    <div
      className="viewer-preview"
      onKeyDown={(event) => {
        const command = event.ctrlKey || event.metaKey
        const searchInput =
          event.currentTarget.querySelector<HTMLInputElement>('[aria-label="搜索 PDF"]')
        if (
          command &&
          event.key.toLowerCase() === 'f' &&
          searchInput &&
          !searchInput.closest('[hidden]')
        ) {
          event.preventDefault()
          searchInput.focus()
        } else if (command && ['+', '=', '-'].includes(event.key)) {
          event.preventDefault()
          zoom(event.key === '-' ? -1 : 1)
        } else if (
          !(event.target as Element).closest('input,textarea,select') &&
          ['PageUp', 'PageDown'].includes(event.key)
        ) {
          event.preventDefault()
          goPage(current + (event.key === 'PageUp' ? -1 : 1))
        }
      }}
    >
      <ViewerBar floating label="PDF 控制栏">
        <div className="viewer-toolbar-group" role="group" aria-label="PDF 导航面板" hidden>
          <button
            aria-pressed={sidebar === 'thumbs'}
            onClick={() => setSidebar(sidebar === 'thumbs' ? null : 'thumbs')}
          >
            <ToolbarIcon name="thumbs" />
            缩略图
          </button>
          <button
            aria-pressed={sidebar === 'outline'}
            onClick={() => setSidebar(sidebar === 'outline' ? null : 'outline')}
          >
            <ToolbarIcon name="outline" />
            目录
          </button>
        </div>
        <PageControl
          format="PDF"
          selectable={false}
          current={current}
          total={doc?.numPages || 0}
          onChange={goPage}
        />
        <ZoomControl value={scale} onZoom={zoom} />
        <ToolbarMore zoom={{ value: scale, onZoom: zoom }}>
          <FitControls fit={fit} onFit={setFit} />
          <ControlButton
            icon="rotate"
            label="旋转"
            onClick={() => setRotation((value) => (value + 90) % 360)}
          >
            旋转页面
          </ControlButton>
          <ControlButton
            icon="info"
            label="文档信息"
            aria-pressed={showInfo}
            onClick={() => setShowInfo((value) => !value)}
          >
            文档信息
          </ControlButton>
        </ToolbarMore>
      </ViewerBar>
      <div className="viewer-bar viewer-search-controls" hidden>
        <input
          aria-label="搜索 PDF"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
        />
        <button onClick={() => void search()}>搜索</button>
        <span role="status">{matches.length ? `${hit + 1}/${matches.length}` : '无匹配'}</span>
        <button disabled={!matches.length} onClick={() => step(-1)}>
          上一处
        </button>
        <button disabled={!matches.length} onClick={() => step(1)}>
          下一处
        </button>
      </div>
      {error && (
        <p role="alert" className="viewer-error">
          {error}
        </p>
      )}
      {(pageFailures.size > 0 || Object.keys(warnings).length > 0 || info?.info?.IsXFAPresent) && (
        <div className="viewer-warning" role="status">
          {pageFailures.size > 0 && (
            <p>
              {pageFailures.size === geoms.length
                ? `这份 PDF 的 ${pageFailures.size} 页均无法加载，请检查文件或重新打开。`
                : `有 ${pageFailures.size} 页无法加载（第 ${[...pageFailures.keys()]
                    .sort((a, b) => a - b)
                    .slice(0, 5)
                    .join('、')} 页${pageFailures.size > 5 ? '等' : ''}），其余页面仍可阅读。`}
            </p>
          )}
          {Object.entries(warnings).map(([key, message]) => (
            <p key={key}>{message}</p>
          ))}
          {info?.info?.IsXFAPresent && <p>该文档包含 XFA，部分动态表单可能无法完整展示。</p>}
        </div>
      )}
      {showInfo && (
        <div className="viewer-info" role="region" aria-label="文档信息">
          <div className="viewer-info-heading">
            <strong>文档信息</strong>
            <ControlButton icon="close" label="关闭文档信息" onClick={() => setShowInfo(false)} />
          </div>
          {Object.entries(info?.info || {})
            .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
            .map(([key, value]) => (
              <p key={key}>
                {key}：{String(value)}
              </p>
            ))}
        </div>
      )}
      <div className="viewer-reading-body">
        {sidebar && (
          <aside ref={thumbScroll} className="viewer-navigation" hidden>
            {sidebar === 'outline' ? (
              <OutlinePanel
                outline={outline}
                label="PDF 目录"
                emptyLabel="文档无目录"
                note={generated ? '由文档标题识别' : undefined}
                onGoToDest={(dest) => void goToDest(dest)}
              />
            ) : (
              doc &&
              geoms.map((_, i) => (
                <button
                  key={i}
                  data-idx={i}
                  ref={thumbs.setItemRef(i)}
                  aria-label={`第 ${i + 1} 页`}
                  aria-current={current === i + 1}
                  onClick={() => goPage(i + 1)}
                >
                  {pageFailures.has(i + 1) ? (
                    <span className="viewer-pdf-failed-thumb">加载失败</span>
                  ) : (
                    <PdfThumb
                      doc={doc}
                      pageNo={i + 1}
                      rotationDelta={rotation}
                      visible={thumbs.visible.has(i)}
                      rasterW={126}
                    />
                  )}
                  <span>{i + 1}</span>
                </button>
              ))
            )}
          </aside>
        )}
        <div
          ref={scroll}
          onScroll={track}
          className="viewer-pdf-scroll"
          style={{ overflowAnchor: 'none' }}
        >
          {doc &&
            geoms.map((geom, i) => {
              const rot = (geom.rot + rotation) % 360,
                odd = rot % 180 !== 0,
                g = { ...geom, rot },
                threads = notes.get(i) || [],
                active = pageFailures.has(i + 1)
                  ? undefined
                  : threads.find((th) => th.key === activeNote)
              return (
                <div className="viewer-pdf-row" key={i}>
                  <div
                    data-idx={i}
                    ref={visible.setItemRef(i)}
                    className="viewer-pdf-page"
                    style={{
                      width: (odd ? geom.ph : geom.pw) * scale,
                      height: (odd ? geom.pw : geom.ph) * scale,
                    }}
                  >
                    {pageFailures.has(i + 1) ? (
                      <div
                        className="viewer-pdf-failed-page"
                        role="status"
                        aria-label={`第 ${i + 1} 页加载失败`}
                      >
                        <strong>第 {i + 1} 页无法加载</strong>
                        <span>该页内容暂不可用，可继续翻阅其他页面。</span>
                      </div>
                    ) : (
                      <PdfPage
                        doc={doc}
                        pageNo={i + 1}
                        scale={scale}
                        rotationDelta={rotation}
                        visible={visible.visible.has(i)}
                        onRenderState={renderState}
                        onRenderError={renderError}
                      />
                    )}
                    {visible.visible.has(i) && !pageFailures.has(i + 1) && (
                      <>
                        <FormLayer
                          widgets={catalog?.byPage.get(i) || []}
                          geom={g}
                          scale={scale}
                          readOnly
                          edits={new Map()}
                          onEdit={noop}
                        />
                        <LinkLayer
                          doc={doc}
                          pageNo={i + 1}
                          geom={g}
                          scale={scale}
                          onGoToDest={(dest) => void goToDest(dest)}
                        />
                        {matches.flatMap((match, mi) =>
                          match.pageIndex === i
                            ? match.rects.map((rect, ri) => (
                                <div
                                  key={`${mi}-${ri}`}
                                  className={`pdf-search-hit${mi === hit ? ' pdf-search-hit-cur' : ''}`}
                                  style={pdfRectToCss(g, rect, scale)}
                                />
                              ))
                            : [],
                        )}
                        <DrawLayer
                          geom={g}
                          scale={scale}
                          pageWidth={(odd ? geom.ph : geom.pw) * scale}
                          pageHeight={(odd ? geom.pw : geom.ph) * scale}
                          drawings={[]}
                          savedNotes={threads.map((th) => ({
                            key: th.key,
                            at: th.at,
                            color: th.color,
                            contents: th.contents,
                          }))}
                          activeNoteKey={activeNote}
                          tool={null}
                          color={NOTE_FALLBACK_COLOR}
                          strokeWidth={1}
                          selectedId={null}
                          selectTitle=""
                          noteOpenTitle="查看批注"
                          onCommit={noop}
                          onNoteAt={noop}
                          onNoteOpen={(key) => setActiveNote(activeNote === key ? null : key)}
                          onSelect={noop}
                        />
                      </>
                    )}
                  </div>
                  {active && (
                    <NoteMarginColumn
                      width={NOTE_MARGIN_W}
                      threads={[
                        {
                          origIdx: i,
                          root: active,
                          pinX:
                            pdfToView(g, ...active.at)[0] * scale +
                            10 -
                            (odd ? geom.ph : geom.pw) * scale -
                            PAGE_GAP,
                          pinY: pdfToView(g, ...active.at)[1] * scale - 10,
                        },
                      ]}
                      draft={null}
                      activeKey={active.key}
                      author=""
                      lang="zh"
                      readOnly
                      t={(key) => labels[key] || key}
                      onActivate={noop}
                      onReply={noop}
                      editingKey={null}
                      editingText=""
                      onEditStart={noop}
                      onEditChange={noop}
                      onEditCancel={noop}
                      onEditSubmit={noop}
                      onDeleteItem={noop}
                      onClose={() => setActiveNote(null)}
                      onDraftConfirm={noop}
                      onDraftCancel={noop}
                    />
                  )}
                </div>
              )
            })}
        </div>
      </div>
    </div>
  )
}
