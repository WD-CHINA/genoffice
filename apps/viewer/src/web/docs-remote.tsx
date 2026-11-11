import { openingStateText } from './server-session'
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
import { paginateBlocks, visiblePages, type BlockMeasure, type PageDescriptor } from './docx-pagination'
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

export function DocsRemote({ server, fileId, token, name }: Props) {
  const [renderBlocks, setRenderBlocks] = useState<DocxPageBlock[]>([])
  const [visibleUnits, setVisibleUnits] = useState<Map<string, { blocks: any[] }>>(new Map())
  const [retryWindow, setRetryWindow] = useState(0)
  const [page, setPage] = useState<PageSettings>(DEFAULT_PAGE)
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
  const layoutContext = useRef({ styleContext, contentWidth: 1, contentHeight: 1 })
  const auth = useMemo<Record<string, string>>(
    () => (token ? { Authorization: `Bearer ${token}` } : {}) as Record<string, string>,
    [token],
  )
  const pageWidth = twipsToPx(page.pageWidth)
  const pageHeight = twipsToPx(page.pageHeight)
  const paddingTop = twipsToPx(page.marginTop)
  const paddingRight = twipsToPx(page.marginRight)
  const paddingBottom = twipsToPx(page.marginBottom)
  const paddingLeft = twipsToPx(page.marginLeft)
  const contentWidth = Math.max(1, pageWidth - paddingLeft - paddingRight)
  const contentHeight = Math.max(1, pageHeight - paddingTop - paddingBottom)

  layoutContext.current = { styleContext, contentWidth, contentHeight }

  const onAssetsReady = useCallback((id: string) => {
    const active = session.current
    if (!active) return
    const existing = remeasureJobs.current.get(id)
    if (existing?.active === active && !existing.controller.signal.aborted) { existing.dirty = true; return }
    const job = { active, dirty: true, controller: new AbortController() }
    const signal = AbortSignal.any([active.signal, job.controller.signal])
    remeasureJobs.current.set(id, job)
    void remeasureQueue.current.run(signal, async () => {
      while (job.dirty && session.current === active) {
        job.dirty = false
        const unit = visibleModels.current.get(id)
        if (!unit) return
        const layout = layoutContext.current
        const rows = new Map<number, TableRowLayout[]>()
        for (const block of unit.blocks) {
          if (block.type === 'table')
            rows.set(block.docxIndex, await measureTableRows(layout.styleContext, block, layout.contentWidth, signal))
        }
        const heights = await measureBlockHeights(layout.styleContext,
          unit.blocks.filter((block) => block.type !== 'table'), 100, layout.contentWidth, signal)
        if (signal.aborted || session.current !== active || !visibleModels.current.has(id)) return
        const replacement = indexDocxUnit(id, unit.blocks, heights, rows, layout.contentHeight)
        setRenderBlocks((old) => signal.aborted || session.current !== active ||
          visibleModels.current.get(id) !== unit ? old : replaceDocxUnitIndex(old, id, replacement))
      }
    }).catch((caught) => {
      if (session.current === active && !signal.aborted)
        setWindowError(caught instanceof Error ? caught.message : String(caught))
    }).finally(() => {
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
          const rows = new Map<number, TableRowLayout[]>()
          for (const block of unit.blocks) {
            if (block.type === 'table') {
              rows.set(block.docxIndex, await measureTableRows(layout.styleContext, block, layout.contentWidth, active.signal))
              if (session.current !== active) return
            }
          }
          const heights = await measureBlockHeights(
            layout.styleContext, unit.blocks.filter((block) => block.type !== 'table'), 100, layout.contentWidth, active.signal,
          )
          if (session.current !== active) return
          descriptors.push(...indexDocxUnit(unit.id, unit.blocks, heights, rows, layout.contentHeight))
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
          layoutContext.current = {
            ...layoutContext.current,
            contentWidth: Math.max(1, twipsToPx(settings.pageWidth - settings.marginLeft - settings.marginRight)),
            contentHeight: Math.max(1, twipsToPx(settings.pageHeight - settings.marginTop - settings.marginBottom)),
          }
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

  const pages = useMemo(() => {
    if (!renderBlocks.length) return []
    const measures: BlockMeasure[] = renderBlocks.map((item) => ({
      height: item.height,
      breakBefore: item.breakBefore,
    }))
    return paginateBlocks(measures, contentHeight)
  }, [renderBlocks, contentHeight])
  // An oversized image/table can be taller than the text area; let that page
  // grow instead of clipping the block at the page edge.
  const pageBoxHeights = useMemo(
    () => pages.map((page) => Math.max(pageHeight, page.height + paddingTop + paddingBottom + 40)),
    [pages, pageHeight, paddingTop, paddingBottom],
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
                width: pageWidth,
                marginLeft: -pageWidth / 2,
                transform: `translateY(${tops[page.index]}px)`,
              }}
            >
              <div
                className="viewer-doc-remote-page"
                style={{
                  width: pageWidth,
                  height: pageBoxHeights[page.index],
                  padding: `${paddingTop}px ${paddingRight}px ${paddingBottom}px ${paddingLeft}px`,
                }}
              >
                {renderBlocks.slice(page.blockStart, page.blockEnd).every((item) => visibleUnits.has(item.unitId)) ? (
                  <PageEditor
                    unitKey={JSON.stringify([...new Set(renderBlocks.slice(page.blockStart, page.blockEnd).map((item) => item.unitId))])}
                    onAssetsReady={onAssetsReady}
                    blocks={renderBlocks.slice(page.blockStart, page.blockEnd).map((item) => {
                      const block = visibleUnits.get(item.unitId)!.blocks[item.blockIndex]
                      return item.tablePage ? sliceTableBlock(block, item.tablePage) : block
                    })}
                    doc={styleContext}
                  />
                ) : <p role="status">正在加载正文…</p>}
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
