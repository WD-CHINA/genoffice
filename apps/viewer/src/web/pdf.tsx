import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { ToolbarIcon } from './toolbar-icon'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfPage, useVisibleSet } from '@genoffice/viewer-renderers/pdf/renderer/PdfPage'
import { PdfThumb } from '@genoffice/viewer-renderers/pdf/renderer/PdfThumb'
import { FormLayer } from '@genoffice/viewer-renderers/pdf/renderer/FormLayer'
import { LinkLayer } from '@genoffice/viewer-renderers/pdf/renderer/LinkLayer'
import { buildFormCatalog } from '@genoffice/viewer-renderers/pdf/renderer/form-catalog'
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
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<SearchMatch[]>([]),
    [hit, setHit] = useState(0),
    [current, setCurrent] = useState(1),
    [sidebar, setSidebar] = useState<'thumbs' | 'outline' | null>('thumbs'),
    [outline, setOutline] = useState<OutlineNode[]>([]),
    [generated, setGenerated] = useState(false),
    [info, setInfo] = useState<any>(null),
    [showInfo, setShowInfo] = useState(false),
    [notes, setNotes] = useState<Map<number, NoteThreadItem[]>>(new Map()),
    [activeNote, setActiveNote] = useState<string | null>(null),
    [fit, setFit] = useState<'width' | 'page' | null>(null)
  const scroll = useRef<HTMLDivElement>(null),
    thumbScroll = useRef<HTMLDivElement>(null),
    index = useRef<Promise<any> | null>(null),
    loadingNotes = useRef(new Set<number>())
  const visible = useVisibleSet(scroll, doc?.numPages || 0, '800px', !!doc)
  const thumbs = useVisibleSet(
    thumbScroll,
    doc?.numPages || 0,
    '200px',
    !!doc && sidebar === 'thumbs',
  )
  const renderState = useCallback(noop, [])
  useEffect(() => {
    let stopped = false
    const task = getDocument({ url: src, ...DOC_OPTS })
    task.onPassword = (update: (password: string) => void, reason: number) => {
      const value = window.prompt(reason === 2 ? 'PDF 密码不正确，请重试' : '请输入 PDF 打开密码')
      if (value !== null) update(value)
      else {
        setError('已取消密码输入')
        void task.destroy()
      }
    }
    void task.promise
      .then(async (document) => {
        const sizes = []
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i)
          const vp = page.getViewport({ scale: 1, rotation: 0 })
          sizes.push({
            pw: vp.width,
            ph: vp.height,
            rot: page.rotate,
            x0: page.view[0],
            y0: page.view[1],
            userUnit: page.userUnit,
          })
        }
        const forms = await buildFormCatalog(document),
          metadata = await document.getMetadata()
        if (stopped) return
        setGeoms(sizes)
        setCatalog(forms)
        setInfo(metadata)
        setDoc(document)
        const embedded = await document.getOutline()
        const tree = embedded?.length
          ? embedded
          : await buildHeadingOutline(document, () => stopped)
        if (!stopped) {
          setOutline((tree || []) as OutlineNode[])
          setGenerated(!embedded?.length)
        }
      })
      .catch((e) => {
        if (!stopped) setError(e.message)
      })
    return () => {
      stopped = true
      void task.destroy()
    }
  }, [src])
  useEffect(() => {
    if (!doc) return
    let cancelled = false
    for (const page of visible.visible) {
      if (loadingNotes.current.has(page)) continue
      loadingNotes.current.add(page)
      void loadSavedAnnots(doc, page)
        .then((value) => {
          if (!cancelled)
            setNotes((old) => new Map(old).set(page, buildNoteThreads(value.notes, [])))
        })
        .catch(() => {
          loadingNotes.current.delete(page)
        })
    }
    return () => {
      cancelled = true
      for (const page of visible.visible) if (!notes.has(page)) loadingNotes.current.delete(page)
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
      const geom = geoms[current - 1] || geoms[0],
        odd = (geom.rot + rotation) % 180 !== 0,
        w = odd ? geom.ph : geom.pw,
        h = odd ? geom.pw : geom.ph
      setScale(
        Math.max(
          MIN_SCALE,
          Math.min(
            MAX_SCALE,
            fit === 'width'
              ? (element.clientWidth - 48) / w
              : Math.min((element.clientWidth - 48) / w, (element.clientHeight - 48) / h),
          ),
        ),
      )
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [fit, geoms, current, rotation, sidebar])
  async function search() {
    if (!doc) return
    try {
      index.current ??= buildSearchIndex(doc)
      const found = searchInIndex(await index.current, query)
      setMatches(found)
      setHit(0)
      if (found.length) goPage(found[0].pageIndex + 1)
    } catch (e) {
      setError(String(e))
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
      <header className="viewer-bar">
        <div className="viewer-toolbar-group" role="group" aria-label="PDF 导航面板">
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
        <div className="viewer-toolbar-group" role="group" aria-label="PDF 页面导航">
          <button disabled={current === 1} onClick={() => goPage(current - 1)}>
            <ToolbarIcon name="previous" />
            上一页
          </button>
          <label>
            页码
            <select
              aria-label="PDF 页码"
              value={current}
              onChange={(e) => goPage(Number(e.target.value))}
            >
              {Array.from({ length: doc?.numPages || 1 }, (_, index) => (
                <option key={index} value={index + 1}>
                  第 {index + 1} 页
                </option>
              ))}
            </select>
          </label>
          <span className="viewer-page-count">/ {doc?.numPages || 0}</span>
          <button disabled={current === (doc?.numPages || 0)} onClick={() => goPage(current + 1)}>
            下一页
            <ToolbarIcon name="next" />
          </button>
        </div>
        <div className="viewer-toolbar-group" role="group" aria-label="PDF 缩放">
          <button onClick={() => zoom(-1)}>
            <ToolbarIcon name="minus" />
            缩小
          </button>
          <span className="viewer-zoom-value">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoom(1)}>
            <ToolbarIcon name="plus" />
            放大
          </button>
          <button aria-pressed={fit === 'width'} onClick={() => setFit('width')}>
            <ToolbarIcon name="width" />
            适合宽度
          </button>
          <button aria-pressed={fit === 'page'} onClick={() => setFit('page')}>
            <ToolbarIcon name="page" />
            适合页面
          </button>
        </div>
        <div
          className="viewer-toolbar-group viewer-toolbar-end"
          role="group"
          aria-label="PDF 文档操作"
        >
          <button onClick={() => setRotation((r) => (r + 90) % 360)}>
            <ToolbarIcon name="rotate" />
            旋转
          </button>
          <button aria-pressed={showInfo} onClick={() => setShowInfo((v) => !v)}>
            <ToolbarIcon name="info" />
            文档信息
          </button>
        </div>
      </header>
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
      {error && <p role="alert">{error}</p>}
      {info?.info?.IsXFAPresent && (
        <p className="viewer-warning" role="status">
          该文档包含 XFA，部分动态表单可能无法完整展示。
        </p>
      )}
      {showInfo && (
        <div className="viewer-info">
          <strong>文档信息</strong>
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
          <aside ref={thumbScroll} className="viewer-navigation">
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
                  <PdfThumb
                    doc={doc}
                    pageNo={i + 1}
                    rotationDelta={rotation}
                    visible={thumbs.visible.has(i)}
                    rasterW={126}
                  />
                  <span>{i + 1}</span>
                </button>
              ))
            )}
          </aside>
        )}
        <div ref={scroll} onScroll={track} className="viewer-pdf-scroll">
          {doc &&
            geoms.map((geom, i) => {
              const rot = (geom.rot + rotation) % 360,
                odd = rot % 180 !== 0,
                g = { ...geom, rot },
                threads = notes.get(i) || [],
                active = threads.find((th) => th.key === activeNote)
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
                    <PdfPage
                      doc={doc}
                      pageNo={i + 1}
                      scale={scale}
                      rotationDelta={rotation}
                      visible={visible.visible.has(i)}
                      onRenderState={renderState}
                    />
                    {visible.visible.has(i) && (
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
