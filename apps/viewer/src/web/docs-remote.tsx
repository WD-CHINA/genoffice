import { applyDocLayoutSettings } from '@genoffice/viewer-renderers/docs/renderer/viewer-initialize'
import type { DocxBlockGeometry } from './docx-fragments'
import { openingStateText } from './server-session'
import { combineAbortSignals } from './abort-signals'
import { DocxRemoteSession } from './docx-remote-session'
import { DocxFontScope } from './docx-font-scope'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { viewerEditorOptions } from '@genoffice/viewer-renderers/docs/renderer/viewer-extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import { LocaleProvider } from '@genoffice/viewer-renderers/docs/renderer/i18n/locale'
import { visiblePages } from './docx-pagination'
import type { DocxReadingContext, DocxStyleContext, SectionInfo } from '@genoffice/docx-engine'
import { sectionFromSectPr } from '@genoffice/docx-engine'
import { setNoteNumFmts } from '@genoffice/viewer-renderers/docs/renderer/note-format'
import {
  loadReadingPosition,
  saveDocxReadingAnchor,
  type DocxReadingAnchor,
} from './reading-position'
import { type TableRowLayout } from './docx-table-pagination'
import { indexDocxUnit, replaceDocxUnitIndex, type DocxPageBlock } from './docx-page-index'
import { DocxReadQueue } from './docx-read-queue'
import { measureTableRows } from './docx-table-measure'
import { measureBlockHeights } from './docx-block-measure'
import {
  reviveDocxStyles,
  mountDocxStyles,
  docxSectionTypography,
  type RemoteDocxStyleContext,
} from './docx-style-context'
import {
  continuousDocxLayout,
  captureContinuousDocxAnchor,
  restoreContinuousDocxAnchor,
} from './docx-continuous-layout'
import { DocxReadingBar, DocxReadingHf, DocxReadingNotes, useDocxReadingZoom } from './docx-reading'
import themeSansUrl from '@genoffice/viewer-renderers/docs/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2?url'
import { docxReadingPageStyle } from './docx-reading-page'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'

const DEFAULT_PAGE = {
  pageWidth: 11906,
  pageHeight: 16838,
  marginTop: 1440,
  marginRight: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
}
interface Props {
  server: string
  fileId: string
  token?: string
  name?: string
}
type StyleContext = RemoteDocxStyleContext
interface RemoteLayout {
  styleContext: StyleContext
  docx: DocxReadingContext
}

function ReadingUnit({
  blocks,
  doc,
  unitId,
  onAssetsReady,
}: {
  blocks: any[]
  doc: StyleContext
  unitId: string
  onAssetsReady: (id: string) => void
}) {
  const editor = useEditor({
    ...viewerEditorOptions,
    editorProps: { attributes: { class: 'doc-page', lang: doc.docDefaults?.lang ?? 'en-US' } },
  })
  useEffect(() => {
    if (!editor) return
    const storage = editor.storage.listNumbering as any
    storage.styles = doc.styles
    storage.docDefaults = doc.docDefaults
    storage.defs = doc.numbering
    applyDocLayoutSettings(editor, doc as unknown as import('@genoffice/docx-engine').ParsedDocFull)
    editor.commands.setContent(blocksToPmDoc(blocks, undefined, pmDocOptions(doc)), {
      emitUpdate: false,
    })
  }, [editor, blocks, doc])
  useEffect(() => {
    if (!editor) return
    const ready = () => onAssetsReady(unitId)
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
  }, [editor, unitId, onAssetsReady])
  return <EditorContent editor={editor} />
}

/** Full source blocks are measured once; paper height never divides a table or paragraph. */
async function measureUnit(
  id: string,
  blocks: any[],
  layout: RemoteLayout,
  signal: AbortSignal,
): Promise<DocxPageBlock[]> {
  const settings = layout.docx.sections.at(-1)!.settings
  const width = (settings.pageWidth - settings.marginLeft - settings.marginRight) / 15
  const geometries = new Map<number, DocxBlockGeometry>()
  const rows = new Map<number, TableRowLayout[]>()
  const heights = await measureBlockHeights(
    layout.styleContext,
    blocks.filter((block) => block.type !== 'table'),
    100,
    width,
    signal,
    geometries,
    settings,
  )
  for (const block of blocks)
    if (block.type === 'table') {
      const tableRows = await measureTableRows(
        layout.styleContext,
        block,
        width,
        signal,
        geometries,
        settings,
      )
      rows.set(block.docxIndex, tableRows)
      heights.set(
        block.docxIndex,
        tableRows.reduce((sum, row) => sum + row.height, 0),
      )
    }
  return indexDocxUnit(id, blocks, heights, rows, Infinity, geometries)
}

export function DocsRemote({ server, fileId, token, name }: Props) {
  const [sourceBlocks, setRenderBlocks] = useState<DocxPageBlock[]>([])
  const [visibleUnits, setVisibleUnits] = useState<Map<string, { blocks: any[] }>>(new Map())
  const [retryWindow, setRetryWindow] = useState(0)
  const [page, setPage] = useState(DEFAULT_PAGE)
  const [docx, setDocx] = useState<DocxReadingContext>()
  const [styleContext, setStyleContext] = useState<StyleContext>({
    styles: new Map(),
    numbering: new Map(),
    css: '',
  })
  const [status, setStatus] = useState('正在创建 DOCX 会话…')
  const [error, setError] = useState('')
  const [windowError, setWindowError] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(720)
  const [contentOffset, setContentOffset] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [cursor, setCursor] = useState<string>()
  const [hasMore, setHasMore] = useState(false)
  const session = useRef<DocxRemoteSession | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLDivElement>(null)
  const scrollPosition = useRef(0)
  const restoredAnchor = useRef(false)
  const pendingAnchor = useRef<DocxReadingAnchor | undefined>(undefined)
  const prefetchAttempts = useRef(0)
  const prefetching = useRef(false)
  const previousLayout = useRef<
    { key: string; blocks: DocxPageBlock[]; offset: number } | undefined
  >(undefined)
  const loadingRef = useRef(false)
  const visibleModels = useRef(visibleUnits)
  visibleModels.current = visibleUnits
  const remeasureQueue = useRef(new DocxReadQueue(2))
  const remeasureJobs = useRef(
    new Map<string, { active: DocxRemoteSession; dirty: boolean; controller: AbortController }>(),
  )
  const fallbackSection = useMemo<SectionInfo>(
    () => ({
      ...sectionFromSectPr('', 0, Number.MAX_SAFE_INTEGER),
      settings: { ...sectionFromSectPr('', 0, Number.MAX_SAFE_INTEGER).settings, ...page },
    }),
    [page],
  )
  const documentContext = useMemo<DocxReadingContext>(
    () =>
      docx ?? {
        sections: [fallbackSection],
        hfParts: {},
        evenAndOddHeaders: false,
        mirrorMargins: false,
        footnotes: [],
        endnotes: [],
        noteNumbers: {},
      },
    [docx, fallbackSection],
  )
  const settings = documentContext.sections.at(-1)!.settings
  const controls = useDocxReadingZoom(viewport, settings.pageWidth / 15)
  const layoutContext = useRef<RemoteLayout>({ styleContext, docx: documentContext })
  layoutContext.current = { styleContext, docx: documentContext }
  const auth = useMemo<Record<string, string>>(
    () => (token ? { Authorization: `Bearer ${token}` } : ({} as Record<string, string>)),
    [token],
  )
  const onAssetsReady = useCallback((id: string) => {
    const active = session.current
    if (!active) return
    const existing = remeasureJobs.current.get(id)
    if (existing?.active === active && !existing.controller.signal.aborted) {
      existing.dirty = true
      return
    }
    const job = { active, dirty: true, controller: new AbortController() }
    const combined = combineAbortSignals([active.signal, job.controller.signal])
    const signal = combined.signal
    remeasureJobs.current.set(id, job)
    void remeasureQueue.current
      .run(signal, async () => {
        while (job.dirty && session.current === active) {
          job.dirty = false
          const unit = visibleModels.current.get(id)
          if (!unit) return
          const layout = layoutContext.current
          const replacement = await measureUnit(id, unit.blocks, layout, signal)
          if (signal.aborted || session.current !== active || !visibleModels.current.has(id)) return
          setRenderBlocks((old) =>
            signal.aborted || session.current !== active || visibleModels.current.get(id) !== unit
              ? old
              : replaceDocxUnitIndex(old, id, replacement),
          )
        }
      })
      .catch((caught) => {
        if (session.current === active && !signal.aborted)
          setWindowError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
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
      setRenderBlocks((old) =>
        session.current === active && !active.signal.aborted ? [...old, ...descriptors] : old,
      )
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
    setStyleContext({ styles: new Map(), numbering: new Map(), css: '' })
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
    let disposeStyles = () => {}
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
          const settings = opened.model.page as unknown as typeof DEFAULT_PAGE
          setPage(settings)
          const fallback = sectionFromSectPr('', 0, Number.MAX_SAFE_INTEGER)
          layoutContext.current = {
            ...layoutContext.current,
            docx: {
              ...layoutContext.current.docx,
              sections: [{ ...fallback, settings: { ...fallback.settings, ...settings } }],
            },
          }
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
        const styles = (await response.json()) as DocxStyleContext
        if (session.current === active && !signal.aborted) {
          disposeStyles()
          const context = reviveDocxStyles(
            styles,
            layoutContext.current.docx,
            fontScope.lineMetrics(),
          )
          disposeStyles = mountDocxStyles(context, themeSansUrl)
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
      disposeStyles()
    }
  }, [server, fileId, token, auth, loadChunk])

  const layout = useMemo(() => continuousDocxLayout(sourceBlocks), [sourceBlocks])
  useLayoutEffect(() => {
    const element = viewport.current,
      body = canvas.current
    if (!element || !body) return
    const update = () => {
      setViewportHeight(element.clientHeight)
      const offset =
        (body.getBoundingClientRect().top -
          element.getBoundingClientRect().top +
          element.scrollTop) /
        controls.zoom
      setContentOffset((old) => (Math.abs(old - offset) < 0.5 ? old : offset))
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    observer.observe(body.parentElement!)
    update()
    return () => observer.disconnect()
  }, [controls.zoom, documentContext])
  useLayoutEffect(() => {
    const key = JSON.stringify([server, fileId])
    const previous = previousLayout.current
    const element = viewport.current
    if (previous?.key === key && element && scrollPosition.current >= previous.offset) {
      const anchor = captureContinuousDocxAnchor(
        previous.blocks,
        scrollPosition.current - previous.offset,
      )
      const restored = anchor && restoreContinuousDocxAnchor(anchor, sourceBlocks)
      if (restored !== undefined) {
        const next = restored + contentOffset
        element.scrollTop = next * controls.zoom
        scrollPosition.current = next
        setScrollTop(next)
      }
    }
    previousLayout.current = { key, blocks: sourceBlocks, offset: contentOffset }
  }, [server, fileId, sourceBlocks, contentOffset, controls.zoom])
  useEffect(() => {
    if (restoredAnchor.current || !sourceBlocks.length || !viewport.current) return
    const saved = pendingAnchor.current ?? loadReadingPosition(fileId)?.anchor
    if (!saved) {
      restoredAnchor.current = true
      return
    }
    const restored = restoreContinuousDocxAnchor(saved, sourceBlocks)
    if (restored === undefined) return
    restoredAnchor.current = true
    pendingAnchor.current = undefined
    const next = restored + contentOffset
    viewport.current.scrollTop = next * controls.zoom
    scrollPosition.current = next
    setScrollTop(next)
  }, [fileId, sourceBlocks, contentOffset, controls.zoom])
  useEffect(() => {
    const saved = pendingAnchor.current
    if (!saved || restoredAnchor.current || !sourceBlocks.length) return
    if (sourceBlocks.some((block) => block.unitId === saved.unitId)) return
    if (!hasMore || loadingRef.current || prefetching.current || prefetchAttempts.current >= 20) {
      pendingAnchor.current = undefined
      return
    }
    prefetchAttempts.current++
    prefetching.current = true
    const active = session.current
    if (active)
      void loadChunk(active, cursor).finally(() => {
        prefetching.current = false
      })
    else prefetching.current = false
  }, [sourceBlocks, hasMore, cursor, loadChunk])
  useEffect(() => {
    if (!sourceBlocks.length) return
    const timer = setTimeout(() => {
      const anchor = captureContinuousDocxAnchor(
        sourceBlocks,
        scrollPosition.current - contentOffset,
      )
      if (!anchor) return
      saveDocxReadingAnchor(fileId, anchor)
      session.current?.setLayoutPrefs({
        anchor: {
          unitId: anchor.unitId,
          blockIndex: anchor.blockIndex,
          offsetPx: Math.round(anchor.offset),
        },
      })
    }, 600)
    return () => clearTimeout(timer)
  }, [fileId, sourceBlocks, scrollTop, contentOffset])
  const tops = useMemo(
    () => layout.units.map((unit) => unit.top + contentOffset),
    [layout, contentOffset],
  )
  const heights = useMemo(() => layout.units.map((unit) => unit.height), [layout])
  const range = visiblePages(tops, heights, scrollTop, viewportHeight / controls.zoom, 2)
  const requiredKey = JSON.stringify(
    layout.units.slice(range.start, range.end).map((unit) => unit.id),
  )
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
    // Keep overlapping units mounted, but drop every model outside the new window.
    setVisibleUnits(
      (old) =>
        new Map(
          requiredUnits.flatMap((id) => {
            const unit = old.get(id)
            return unit ? [[id, unit] as const] : []
          }),
        ),
    )
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
    return () => {
      cancelled = true
    }
  }, [requiredKey, retryWindow])

  useEffect(() => {
    const element = viewport.current
    if (
      hasMore &&
      !loadingMore &&
      !error &&
      element &&
      element.scrollHeight <= element.clientHeight + 240 &&
      session.current
    )
      void loadChunk(session.current, cursor)
  }, [hasMore, loadingMore, error, cursor, loadChunk, layout.height])
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setScrollTop(element.scrollTop / controls.zoom)
    scrollPosition.current = element.scrollTop / controls.zoom
    if (
      hasMore &&
      !loadingRef.current &&
      element.scrollTop + element.clientHeight > element.scrollHeight - 240 &&
      session.current
    )
      void loadChunk(session.current, cursor)
  }
  return (
    <LocaleProvider initial="zh">
      <div
        className="viewer-preview viewer-doc-remote viewer-doc-reading read-mode"
        data-docx-theme-fallback={styleContext.missingThemeFallback ? 'bundled' : undefined}
        aria-label={name}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && ['+', '=', '-'].includes(event.key)) {
            event.preventDefault()
            controls.changeZoom(event.key === '-' ? -1 : 1)
          }
        }}
      >
        {!!sourceBlocks.length && <DocxReadingBar controls={controls} />}
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
        <div
          className="viewer-doc-reading-scroll editor-scroll"
          tabIndex={0}
          ref={viewport}
          onScroll={onScroll}
          style={{ overflowAnchor: 'none' }}
        >
          <div className="doc-zoom" style={{ zoom: controls.zoom }}>
            <div
              className="page-wrap viewer-doc-reading-paper"
              style={{
                ...docxReadingPageStyle(settings),
                ...docxSectionTypography(settings),
              }}
            >
              <DocxReadingHf context={documentContext} kind="header" />
              <div
                ref={canvas}
                className="viewer-doc-remote-canvas"
                role="document"
                aria-label="Word 文档正文"
                style={{ height: layout.height }}
              >
                {layout.units.slice(range.start, range.end).map((unit) => (
                  <div
                    key={unit.id}
                    className="viewer-doc-reading-unit"
                    data-unit-id={unit.id}
                    style={{ position: 'absolute', top: unit.top, width: '100%' }}
                  >
                    {visibleUnits.has(unit.id) ? (
                      <ReadingUnit
                        blocks={visibleUnits.get(unit.id)!.blocks}
                        doc={styleContext}
                        unitId={unit.id}
                        onAssetsReady={onAssetsReady}
                      />
                    ) : (
                      <p role="status">正在加载正文…</p>
                    )}
                  </div>
                ))}
              </div>
              {!hasMore && !loadingMore && (
                <>
                  <DocxReadingNotes context={documentContext} styles={styleContext} />
                  <DocxReadingHf context={documentContext} kind="footer" />
                </>
              )}
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
      </div>
    </LocaleProvider>
  )
}
