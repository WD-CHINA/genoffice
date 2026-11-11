import { openingStateText } from './server-session'
import { combineAbortSignals } from './abort-signals'
import { DocxRemoteSession } from './docx-remote-session'
import { DocxFontScope } from './docx-font-scope'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { editorExtensions } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'
import { visiblePages, type PageDescriptor } from './docx-pagination'
import type { DocxReadingContext, SectionInfo, SectionSettings } from '@genoffice/docx-engine'
import { sectionFromSectPr } from '@genoffice/docx-engine'
import { HeaderFooterArea } from '@genoffice/viewer-renderers/docs/renderer/components/HeaderFooterArea'
import { formatPageNumber } from '@genoffice/viewer-renderers/docs/renderer/pagination-hf'
import { setNoteNumFmts } from '@genoffice/viewer-renderers/docs/renderer/note-format'
import { hfReservedHeightPx, hfStripGeom } from '@genoffice/viewer-renderers/docs/renderer/editor/hf-dom'
import { hfHeightKey, paginateSectionBlocks, sectionColumns, sectionContentHeight, sectionIndexAt, type HfHeights } from './docx-section-layout'
import { captureDocxAnchor, restoreDocxAnchor } from './docx-scroll-anchor'
import {
  loadReadingPosition, saveDocxReadingAnchor, type DocxReadingAnchor,
} from './reading-position'
import { type TableRowLayout } from './docx-table-pagination'
import { indexDocxUnit, replaceDocxUnitIndex, type DocxPageBlock } from './docx-page-index'
import { DocxReadQueue } from './docx-read-queue'
import { measureTableRows, sliceTableBlock } from './docx-table-measure'
import { measureBlockHeights } from './docx-block-measure'

interface PageSettings {
  pageWidth: number
  pageHeight: number
  marginTop: number
  marginRight: number
  marginBottom: number
  marginLeft: number
}

const DEFAULT_PAGE: PageSettings = {
  pageWidth: 11906,
  pageHeight: 16838,
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
}
const PAGE_GAP = 24
const OVERSCAN = 2
const twipsToPx = (twips: number): number => twips / 15

interface Props {
  server: string
  fileId: string
  token?: string
  name?: string
}

interface StyleContextPayload {
  styles: Array<[string, any]>
  docDefaults?: any
  numbering: Array<[string, any]>
  themeColors?: any
  themeFonts?: any
}

interface StyleContext {
  styles: Map<string, any>
  numbering: Map<string, any>
  docDefaults?: any
  themeColors?: any
  themeFonts?: any
}

function reviveStyleContext(payload: StyleContextPayload): StyleContext {
  return {
    styles: new Map(payload.styles),
    numbering: new Map(payload.numbering),
    docDefaults: payload.docDefaults,
    themeColors: payload.themeColors,
    themeFonts: payload.themeFonts,
  }
}

function PageEditor({ blocks, doc, unitKey, onAssetsReady }: {
  blocks: any[]; doc: StyleContext; unitKey: string; onAssetsReady: (id: string) => void
}) {
  const editor = useEditor({
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(blocksToPmDoc(blocks, undefined, pmDocOptions(doc)), {
      emitUpdate: false,
    })
  }, [editor, blocks, doc])
  useEffect(() => {
    if (!editor) return
    const ready = () => {
      for (const id of JSON.parse(unitKey) as string[]) onAssetsReady(id)
    }
    const root = editor.view.dom
    root.addEventListener('load', ready, true)
    root.addEventListener('error', ready, true)
    document.fonts.addEventListener('loadingdone', ready)
    const observer = new ResizeObserver(ready)
    observer.observe(root)
    return () => {
      root.removeEventListener('load', ready, true)
      root.removeEventListener('error', ready, true)
      document.fonts.removeEventListener('loadingdone', ready)
      observer.disconnect()
    }
  }, [editor, unitKey, onAssetsReady])
  return <EditorContent editor={editor} />
}

function RemoteHf({ part, kind, settings, number, total, id, left, onHeight }: {
  part: DocxReadingContext['hfParts'][string] | undefined
  kind: 'header' | 'footer'; settings: SectionSettings; number: string; total: number
  id?: string; left: number; onHeight: (key: string, height: number) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const width = twipsToPx(settings.pageWidth - settings.marginLeft - settings.marginRight)
  useLayoutEffect(() => {
    const element = root.current?.querySelector<HTMLElement>('.page-hf')
    if (!element || !id) return
    const measure = () => onHeight(hfHeightKey(id, width), hfReservedHeightPx(kind,
      part ? { text: part.text, pageNumber: part.hasPageNumber, paras: part.paras } : null, width, part?.images,
      { marginTopPx: twipsToPx(settings.marginTop), headerDistPx: twipsToPx(settings.headerDist ?? 720) }))
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    element.addEventListener('load', measure, true)
    document.fonts.addEventListener('loadingdone', measure)
    measure()
    return () => { observer.disconnect(); element.removeEventListener('load', measure, true); document.fonts.removeEventListener('loadingdone', measure) }
  }, [id, width, onHeight, part, kind, settings.marginTop, settings.headerDist])
  if (!part) return null
  return <div ref={root} data-hf-part={id} style={{ position: 'absolute', top: 0, bottom: 0, left, width, pointerEvents: 'none' }}>
    <HeaderFooterArea kind={kind} value={{ text: part.text, pageNumber: part.hasPageNumber, paras: part.paras }}
      images={part.images} readOnly onCommit={() => {}} pageNo={number} pageTotal={total}
      boxGeom={hfStripGeom(settings)}
      style={{ width, left: 0, transform: 'none', pointerEvents: 'auto',
        ...(kind === 'header' ? { top: twipsToPx(settings.headerDist ?? 720), bottom: 'auto' }
          : { bottom: twipsToPx(settings.footerDist ?? 720), top: 'auto' }) }} />
  </div>
}

interface RemoteLayout {
  styleContext: StyleContext
  docx: DocxReadingContext
  hfHeights: HfHeights
}

async function measureUnit(id: string, blocks: any[], layout: RemoteLayout, signal: AbortSignal): Promise<DocxPageBlock[]> {
  const rows = new Map<number, TableRowLayout[]>()
  const heights = new Map<number, number>()
  const groups = new Map<number, any[]>()
  for (const block of blocks) {
    const section = sectionIndexAt(layout.docx.sections, block.docxIndex)
    const group = groups.get(section) ?? []
    group.push(block); groups.set(section, group)
  }
  for (const [index, group] of groups) {
    const width = Math.min(...sectionColumns(layout.docx.sections[index].settings).map((column) => column.width))
    for (const block of group)
      if (block.type === 'table') rows.set(block.docxIndex, await measureTableRows(layout.styleContext, block, width, signal))
    const measured = await measureBlockHeights(layout.styleContext, group.filter((block) => block.type !== 'table'), 100, width, signal)
    for (const [key, value] of measured) heights.set(key, value)
  }
  return indexDocxUnit(id, blocks, heights, rows, (block) =>
    sectionContentHeight(layout.docx, sectionIndexAt(layout.docx.sections, block.docxIndex), layout.hfHeights))
}

export function DocsRemote({ server, fileId, token, name }: Props) {
  const [renderBlocks, setRenderBlocks] = useState<DocxPageBlock[]>([])
  const [visibleUnits, setVisibleUnits] = useState<Map<string, { blocks: any[] }>>(new Map())
  const [retryWindow, setRetryWindow] = useState(0)
  const [page, setPage] = useState<PageSettings>(DEFAULT_PAGE)
  const [docx, setDocx] = useState<DocxReadingContext | undefined>()
  const [hfHeights, setHfHeights] = useState<Map<string, number>>(new Map())
  const [styleContext, setStyleContext] = useState<StyleContext>({
    styles: new Map(),
    numbering: new Map(),
  })
  const [status, setStatus] = useState('正在创建 DOCX 会话…')
  const [error, setError] = useState('')
  const [windowError, setWindowError] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const session = useRef<DocxRemoteSession | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const scrollPosition = useRef(0)
  const restoredAnchor = useRef(false)
  const pendingAnchor = useRef<DocxReadingAnchor | undefined>(undefined)
  const prefetchAttempts = useRef(0)
  const prefetching = useRef(false)
  const previousLayout = useRef<{
    key: string; blocks: DocxPageBlock[]; pages: PageDescriptor[]; tops: number[]; paddingTop: number
  } | undefined>(undefined)
  const loadingRef = useRef(false)
  const visibleModels = useRef(visibleUnits)
  visibleModels.current = visibleUnits
  const remeasureQueue = useRef(new DocxReadQueue(2))
  const remeasureJobs = useRef(new Map<string, { active: DocxRemoteSession; dirty: boolean; controller: AbortController }>())
  const fallbackSection = useMemo<SectionInfo>(() => ({ ...sectionFromSectPr('', 0, Number.MAX_SAFE_INTEGER),
    settings: { ...sectionFromSectPr('', 0, Number.MAX_SAFE_INTEGER).settings, ...page } }), [page])
  const documentContext = useMemo<DocxReadingContext>(() => docx ?? {
    sections: [fallbackSection], hfParts: {}, evenAndOddHeaders: false, mirrorMargins: false,
    footnotes: [], endnotes: [], noteNumbers: {},
  }, [docx, fallbackSection])
  const layoutContext = useRef<RemoteLayout>({ styleContext, docx: documentContext, hfHeights })
  const auth = useMemo<Record<string, string>>(
    () => (token ? { Authorization: `Bearer ${token}` } : {}) as Record<string, string>,
    [token],
  )
  const paddingTop = twipsToPx(page.marginTop)
  layoutContext.current = { styleContext, docx: documentContext, hfHeights }
  const onHfHeight = useCallback((key: string, height: number) => setHfHeights((previous) =>
    Math.abs((previous.get(key) ?? 0) - height) < 0.5 ? previous : new Map(previous).set(key, height)), [])

  const onAssetsReady = useCallback((id: string) => {
    const active = session.current
    if (!active) return
    const existing = remeasureJobs.current.get(id)
    if (existing?.active === active && !existing.controller.signal.aborted) { existing.dirty = true; return }
    const job = { active, dirty: true, controller: new AbortController() }
    const combined = combineAbortSignals([active.signal, job.controller.signal])
    const signal = combined.signal
    remeasureJobs.current.set(id, job)
    void remeasureQueue.current.run(signal, async () => {
      while (job.dirty && session.current === active) {
        job.dirty = false
        const unit = visibleModels.current.get(id)
        if (!unit) return
        const layout = layoutContext.current
        const replacement = await measureUnit(id, unit.blocks, layout, signal)
        if (signal.aborted || session.current !== active || !visibleModels.current.has(id)) return
        setRenderBlocks((old) => signal.aborted || session.current !== active ||
          visibleModels.current.get(id) !== unit ? old : replaceDocxUnitIndex(old, id, replacement))
      }
    }).catch((caught) => {
      if (session.current === active && !signal.aborted)
        setWindowError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
      combined.dispose()
      if (remeasureJobs.current.get(id) === job) remeasureJobs.current.delete(id)
    })
  }, [])

  const loadChunk = useCallback(async (active: DocxRemoteSession, next?: string) => {
    if (loadingRef.current || session.current !== active) return
    loadingRef.current = true
    setLoadingMore(true)
    try {
      const descriptors: DocxPageBlock[] = []
      const result = await active.load(next, async (units) => {
        const layout = layoutContext.current
        for (const unit of units) {
          const indexed = await measureUnit(unit.id, unit.blocks, layout, active.signal)
          if (session.current !== active) return
          descriptors.push(...indexed)
        }
      })
      if (session.current !== active) return
      setRenderBlocks((old) => session.current === active && !active.signal.aborted
        ? [...old, ...descriptors] : old)
      setCursor(result.next)
      setHasMore(result.hasMore)
      setError('')
      setStatus('')
    } catch (error) {
      if (session.current === active && (error as Error)?.name !== 'AbortError') {
        setError(error instanceof Error ? error.message : String(error))
        setStatus('')
      }
    } finally {
      if (session.current === active) {
        loadingRef.current = false
        setLoadingMore(false)
      }
    }
  }, [])

  useEffect(() => {
    setRenderBlocks([])
    setVisibleUnits(new Map())
    setPage(DEFAULT_PAGE)
    setDocx(undefined)
    setNoteNumFmts({})
    setHfHeights(new Map())
    setStyleContext({ styles: new Map(), numbering: new Map() })
    setCursor(undefined)
    setHasMore(false)
    setError('')
    setWindowError('')
    setStatus('正在创建 DOCX 会话…')
    setScrollTop(0)
    scrollPosition.current = 0
    restoredAnchor.current = false
    pendingAnchor.current = loadReadingPosition(fileId)?.anchor
    prefetchAttempts.current = 0
    prefetching.current = false
    if (viewport.current) viewport.current.scrollTop = 0
    loadingRef.current = false
    const fontScope = new DocxFontScope()
    const active = new DocxRemoteSession(
      {
        server,
        fileId,
        token,
        onState: (state) => {
          if (session.current === active) setStatus(openingStateText(state))
        },
      },
      async (opened, signal) => {
        if (session.current !== active || signal.aborted) return
        setVisibleUnits(new Map())
        setRetryWindow((value) => value + 1)
        if (opened.model?.page) {
          const settings = opened.model.page as unknown as PageSettings
          setPage(settings)
          const fallback = sectionFromSectPr('', 0, Number.MAX_SAFE_INTEGER)
          layoutContext.current = { ...layoutContext.current, docx: { ...layoutContext.current.docx,
            sections: [{ ...fallback, settings: { ...fallback.settings, ...settings } }] } }
        }
        if (opened.model?.docx) {
          const context = opened.model.docx as unknown as DocxReadingContext
          setDocx(context)
          setNoteNumFmts({ footnote: context.footnoteProps, endnote: context.endnoteProps })
          layoutContext.current = { ...layoutContext.current, docx: context }
        }
        if (opened.fonts?.length)
          await fontScope.load(server, opened.sessionId, opened.fonts, auth, signal)
        const response = await fetch(`${server}/v1/sessions/${opened.sessionId}/styles`, {
          headers: auth,
          signal,
        })
        if (!response.ok) throw new Error(`读取 DOCX 样式失败（HTTP ${response.status}）`)
        const styles = (await response.json()) as StyleContextPayload
        if (session.current === active && !signal.aborted) {
          const context = reviveStyleContext(styles)
          layoutContext.current = { ...layoutContext.current, styleContext: context }
          setStyleContext(context)
        }
      },
    )
    session.current = active
    void loadChunk(active)
    return () => {
      if (session.current === active) session.current = null
      active.close()
      fontScope.close()
    }
  }, [server, fileId, token, auth, loadChunk])

  const pages = useMemo(() => paginateSectionBlocks(renderBlocks, documentContext, hfHeights), [renderBlocks, documentContext, hfHeights])
  useEffect(() => {
    for (const id of visibleModels.current.keys()) onAssetsReady(id)
  }, [hfHeights, onAssetsReady])
  // An oversized image/table can be taller than the text area; let that page
  // grow instead of clipping the block at the page edge.
  const pageBoxHeights = useMemo(
    () => pages.map((page) => Math.max(page.pageHeight, page.height + page.paddingTop + page.paddingBottom)),
    [pages],
  )
  const tops = useMemo(() => {
    const result: number[] = []
    let top = 0
    for (const height of pageBoxHeights) {
      result.push(top)
      top += height + PAGE_GAP
    }
    return result
  }, [pageBoxHeights])
  const totalHeight = tops.length
    ? tops[tops.length - 1] + pageBoxHeights[pageBoxHeights.length - 1]
    : 0
  useLayoutEffect(() => {
    const key = JSON.stringify([server, fileId])
    const previous = previousLayout.current
    const element = viewport.current
    if (previous?.key === key && element) {
      const anchor = captureDocxAnchor(previous.blocks, previous.pages, previous.tops,
        scrollPosition.current, previous.paddingTop)
      const restored = anchor && restoreDocxAnchor(anchor, renderBlocks, pages, tops, paddingTop)
      if (restored !== undefined) {
        element.scrollTop = restored
        scrollPosition.current = element.scrollTop
        setScrollTop(element.scrollTop)
      }
    }
    previousLayout.current = { key, blocks: renderBlocks, pages, tops, paddingTop }
  }, [server, fileId, renderBlocks, pages, tops, paddingTop])
  // Restore a saved DOCX source anchor once, as soon as the first window has
  // enough blocks to resolve it. An anchor whose unit is not loaded yet is left
  // for a later window instead of jumping to the top.
  useEffect(() => {
    if (restoredAnchor.current || !fileId || !renderBlocks.length || !pages.length || !viewport.current)
      return
    const saved = pendingAnchor.current ?? loadReadingPosition(fileId)?.anchor
    if (!saved) {
      restoredAnchor.current = true
      return
    }
    const top = restoreDocxAnchor(saved, renderBlocks, pages, tops, paddingTop)
    if (top === undefined) return
    restoredAnchor.current = true
    pendingAnchor.current = undefined
    viewport.current.scrollTop = top
    scrollPosition.current = top
    setScrollTop(top)
  }, [fileId, renderBlocks, pages, tops, paddingTop])
  // A saved anchor can live past the first window: keep fetching bounded chunks
  // until its unit appears (or the document ends), then the restore effect jumps.
  useEffect(() => {
    const saved = pendingAnchor.current
    if (!saved || restoredAnchor.current || !renderBlocks.length) return
    if (renderBlocks.some((block) => block.unitId === saved.unitId)) return
    if (!hasMore || loadingRef.current || prefetching.current || prefetchAttempts.current >= 20) {
      pendingAnchor.current = undefined
      return
    }
    prefetchAttempts.current++
    prefetching.current = true
    const active = session.current
    if (active) void loadChunk(active, cursor).finally(() => { prefetching.current = false })
    else prefetching.current = false
  }, [renderBlocks, pages, hasMore, cursor, loadChunk])
  // Keep the anchor instead of a page number: reflow can move pages around.
  useEffect(() => {
    if (!fileId || !renderBlocks.length || !pages.length) return
    const timer = setTimeout(() => {
      const anchor = captureDocxAnchor(renderBlocks, pages, tops,
        scrollPosition.current, paddingTop)
      if (anchor) {
        saveDocxReadingAnchor(fileId, anchor)
        session.current?.setLayoutPrefs({
          anchor: { unitId: anchor.unitId, blockIndex: anchor.blockIndex,
            offsetPx: Math.round(anchor.offset) },
        })
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [fileId, renderBlocks, pages, tops, paddingTop, scrollTop])
  const viewportHeight = viewport.current?.clientHeight || 720
  const range = visiblePages(tops, pageBoxHeights, scrollTop, viewportHeight, OVERSCAN)

  const requiredKey = useMemo(() => {
    const ids = new Set<string>()
    for (const page of pages.slice(range.start, range.end))
      for (const item of renderBlocks.slice(page.blockStart, page.blockEnd)) ids.add(item.unitId)
    return JSON.stringify([...ids])
  }, [pages, range.start, range.end, renderBlocks])

  useEffect(() => {
    const active = session.current
    if (!active) return
    let cancelled = false
    setWindowError('')
    const requiredUnits = JSON.parse(requiredKey) as string[]
    active.retainUnits(requiredUnits)
    const required = new Set(requiredUnits)
    for (const [id, job] of remeasureJobs.current) {
      if (job.active === active && !required.has(id)) {
        remeasureJobs.current.delete(id)
        job.controller.abort()
      }
    }
    // Keep overlapping pages mounted, but drop every model outside the new window.
    setVisibleUnits((old) => new Map(requiredUnits.flatMap((id) => {
      const unit = old.get(id)
      return unit ? [[id, unit] as const] : []
    })))
    void (async () => {
      try {
        for (const id of requiredUnits) {
          if (cancelled) return
          const unit = await active.unit(id)
          if (cancelled || session.current !== active) return
          setVisibleUnits((old) => new Map(old).set(id, unit))
        }
      } catch (caught) {
        if (!cancelled && session.current === active && (caught as Error)?.name !== 'AbortError')
          setWindowError(caught instanceof Error ? caught.message : String(caught))
      }
    })()
    return () => { cancelled = true }
  }, [requiredKey, retryWindow])

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setScrollTop(element.scrollTop)
    scrollPosition.current = element.scrollTop
    if (!hasMore || loadingRef.current) return
    if (element.scrollTop + element.clientHeight > element.scrollHeight - 240) {
      if (session.current) void loadChunk(session.current, cursor)
    }
  }

  return (
    <div className="viewer-preview viewer-doc-remote">
      {name && <span className="viewer-doc-remote-name">{name}</span>}
      {status && <p className="viewer-status">{status}</p>}
      {(error || windowError) && (
        <div className="viewer-doc-remote-error" role="alert">
          <span>{error || windowError}</span>
          <button
            type="button"
            onClick={() => {
              setError('')
              setWindowError('')
              setRetryWindow((value) => value + 1)
              if (error && session.current) void loadChunk(session.current, cursor)
            }}
          >
            重试
          </button>
        </div>
      )}
      <div className="viewer-doc-remote-viewport" ref={viewport} onScroll={onScroll} style={{ overflowAnchor: 'none' }}>
        <div className="viewer-doc-remote-canvas" style={{ height: totalHeight }}>
          {pages.slice(range.start, range.end).map((page) => (
            <div
              key={page.index}
              className="viewer-doc-remote-slot"
              style={{
                width: page.width,
                marginLeft: -page.width / 2,
                transform: `translateY(${tops[page.index]}px)`,
              }}
            >
              <div
                className="viewer-doc-remote-page"
                data-section-index={page.sectionIndex}
                data-page-index={page.index}
                data-page-number={formatPageNumber(page.number, documentContext.sections[page.sectionIndex].pageNumberFmt)}
                style={{
                  position: 'relative',
                  width: page.width,
                  height: pageBoxHeights[page.index],
                  padding: 0,
                }}
              >
                <RemoteHf kind="header" id={page.headerId} part={page.headerId ? documentContext.hfParts[page.headerId] : undefined}
                  settings={page.settings} number={formatPageNumber(page.number, documentContext.sections[page.sectionIndex].pageNumberFmt)}
                  total={pages.length} left={page.paddingLeft} onHeight={onHfHeight} />
                {page.regions.map((region, regionIndex) => (
                  <div key={regionIndex} className="viewer-doc-remote-region" data-section-index={region.sectionIndex}
                    data-columns={region.columns.length} style={{ position: 'absolute', top: page.paddingTop + region.top,
                      left: twipsToPx(documentContext.mirrorMargins && page.number % 2 === 0
                        ? documentContext.sections[region.sectionIndex].settings.marginRight
                        : documentContext.sections[region.sectionIndex].settings.marginLeft) }}>
                    {region.columns.filter((column) => column.blockEnd > column.blockStart).map((column, columnIndex) => {
                      const items = renderBlocks.slice(column.blockStart, column.blockEnd)
                      return <div key={columnIndex} className="viewer-doc-remote-column"
                        style={{ position: 'absolute', left: column.left, width: column.width }}>
                        {items.every((item) => visibleUnits.has(item.unitId)) ? <PageEditor
                          unitKey={JSON.stringify([...new Set(items.map((item) => item.unitId))])}
                          onAssetsReady={onAssetsReady}
                          blocks={items.map((item) => {
                            const block = visibleUnits.get(item.unitId)!.blocks[item.blockIndex]
                            return item.tablePage ? sliceTableBlock(block, item.tablePage) : block
                          })} doc={styleContext} /> : <p role="status">正在加载正文…</p>}
                      </div>
                    })}
                  </div>
                ))}
                <RemoteHf kind="footer" id={page.footerId} part={page.footerId ? documentContext.hfParts[page.footerId] : undefined}
                  settings={page.settings} number={formatPageNumber(page.number, documentContext.sections[page.sectionIndex].pageNumberFmt)}
                  total={pages.length} left={page.paddingLeft} onHeight={onHfHeight} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {loadingMore && <p className="viewer-doc-remote-loading">正在加载更多…</p>}
      {hasMore && !loadingMore && (
        <button
          type="button"
          className="viewer-doc-remote-more"
          onClick={() => session.current && void loadChunk(session.current, cursor)}
        >
          加载更多
        </button>
      )}
    </div>
  )
}
