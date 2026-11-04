import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { editorExtensions } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'
import { paginateBlocks, visiblePages, type BlockMeasure } from './docx-pagination'
import { paginateTableRows, type TableRowLayout } from './docx-table-pagination'
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
const CHUNK_LIMIT = 1

interface Props {
  server: string
  fileId: string
  token?: string
  name?: string
}

interface UnitListing {
  items: Array<{ id: string }>
  next?: string
}

function estimateHeight(block: any): number {
  if (block.type === 'table') return 320
  if (block.type === 'image') return 240
  if (block.type === 'passthrough') return 24
  const text = (block.runs || []).map((run: any) => run.text || '').join('')
  return Math.max(24, 22 + Math.ceil(text.length / 70) * 20)
}

function PageEditor({ blocks }: { blocks: any[] }) {
  const editor = useEditor({
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(blocksToPmDoc(blocks, undefined, pmDocOptions({})), {
      emitUpdate: false,
    })
  }, [editor, blocks])
  return <EditorContent editor={editor} />
}

async function loadFonts(
  server: string,
  sessionId: string,
  fonts: Array<{ id: string; family: string; bold: boolean; italic: boolean }>,
  auth: Record<string, string>,
): Promise<void> {
  await Promise.all(
    fonts.map(async (font) => {
      try {
        const response = await fetch(
          `${server}/v1/sessions/${sessionId}/fonts/${encodeURIComponent(font.id)}`,
          { headers: auth },
        )
        if (!response.ok) return
        const bytes = await response.arrayBuffer()
        const face = new FontFace(font.family, bytes, {
          weight: font.bold ? 'bold' : 'normal',
          style: font.italic ? 'italic' : 'normal',
        })
        await face.load()
        document.fonts.add(face)
      } catch {
        /* a missing font should not block the document */
      }
    }),
  )
}

export function DocsRemote({ server, fileId, token, name }: Props) {
  const [blocks, setBlocks] = useState<any[]>([])
  const [page, setPage] = useState<PageSettings>(DEFAULT_PAGE)
  const [tableRows, setTableRows] = useState<Map<number, TableRowLayout[]>>(new Map())
  const [blockHeights, setBlockHeights] = useState<Map<number, number>>(new Map())
  const [status, setStatus] = useState('正在创建 DOCX 会话…')
  const [error, setError] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [hasMore, setHasMore] = useState(false)
  const session = useRef<string | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const measuredTables = useRef(new Set<number>())
  const measuredBlocks = useRef(new Set<number>())
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

  const loadChunk = useCallback(
    async (sessionId: string, next?: string, signal?: AbortSignal) => {
      if (loadingRef.current) return
      loadingRef.current = true
      setLoadingMore(true)
      const controller = signal ? null : new AbortController()
      const requestSignal = signal ?? controller!.signal
      if (controller) {
        abortRef.current?.abort()
        abortRef.current = controller
      }
      try {
        const query = new URLSearchParams({ limit: String(CHUNK_LIMIT) })
        if (next) query.set('cursor', next)
        const listingResponse = await fetch(`${server}/v1/sessions/${sessionId}/units?${query}`, {
          headers: auth,
          signal: requestSignal,
        })
        if (!listingResponse.ok)
          throw new Error(`读取 chunk 列表失败（HTTP ${listingResponse.status}）`)
        const listing = (await listingResponse.json()) as UnitListing
        setCursor(listing.next)
        setHasMore(!!listing.next)
        if (!listing.items.length) {
          setStatus('')
          return
        }
        const loaded: any[] = []
        for (const item of listing.items) {
          const response = await fetch(
            `${server}/v1/sessions/${sessionId}/units/${encodeURIComponent(item.id)}`,
            { headers: auth, signal: requestSignal },
          )
          if (!response.ok) throw new Error(`读取 chunk 失败（HTTP ${response.status}）`)
          loaded.push(...((await response.json()) as { blocks: any[] }).blocks)
        }
        setBlocks((old) => [...old, ...loaded])
        setStatus('')
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') {
          setError(error instanceof Error ? error.message : String(error))
          setStatus('')
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        loadingRef.current = false
        setLoadingMore(false)
      }
    },
    [auth, server],
  )

  const startSession = useCallback(async () => {
    setError('')
    setStatus('正在创建 DOCX 会话…')
    session.current = null
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const created = await fetch(`${server}/v1/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ fileId }),
        signal: controller.signal,
      })
      if (!created.ok) throw new Error(`创建 DOCX 会话失败（HTTP ${created.status}）`)
      const opened = (await created.json()) as {
        sessionId: string
        model?: { page?: PageSettings }
        fonts?: Array<{ id: string; family: string; bold: boolean; italic: boolean }>
      }
      session.current = opened.sessionId
      if (opened.model?.page) setPage(opened.model.page)
      if (opened.fonts?.length) await loadFonts(server, opened.sessionId, opened.fonts, auth)
      await loadChunk(opened.sessionId, undefined, controller.signal)
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        setError(error instanceof Error ? error.message : String(error))
        setStatus('')
      }
    }
  }, [server, fileId, auth, loadChunk])

  useEffect(() => {
    void startSession()
    return () => {
      abortRef.current?.abort()
      if (session.current) {
        void fetch(`${server}/v1/sessions/${session.current}`, {
          method: 'DELETE',
          headers: auth,
        }).catch(() => undefined)
      }
    }
  }, [server, fileId, auth, startSession])

  // Measure table rows as their blocks arrive; do not block the first paint.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const block of blocks) {
        if (block.type !== 'table' || measuredTables.current.has(block.docxIndex)) continue
        measuredTables.current.add(block.docxIndex)
        const rows = await measureTableRows(
          { styles: new Map(), numbering: new Map(), docDefaults: undefined },
          block,
        )
        if (cancelled) return
        setTableRows((old) => new Map(old).set(block.docxIndex, rows))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [blocks, contentWidth])

  // Measure normal block heights incrementally; table blocks use row heights.
  useEffect(() => {
    let cancelled = false
    const pending = blocks.filter(
      (block) =>
        block.type !== 'table' &&
        block.docxIndex != null &&
        !measuredBlocks.current.has(block.docxIndex),
    )
    if (!pending.length) return
    for (const block of pending) measuredBlocks.current.add(block.docxIndex)
    void (async () => {
      const heights = await measureBlockHeights(
        { styles: new Map(), numbering: new Map(), docDefaults: undefined },
        pending,
        100,
        contentWidth,
      )
      if (cancelled) return
      setBlockHeights((old) => {
        const next = new Map(old)
        for (const [index, height] of heights) next.set(index, height)
        return next
      })
    })()
    return () => {
      cancelled = true
    }
  }, [blocks, contentWidth])

  const renderBlocks = useMemo(() => {
    const result: Array<{ block: any; height: number; breakBefore?: boolean }> = []
    for (const block of blocks) {
      const rows = tableRows.get(block.docxIndex)
      if (rows?.length) {
        const headerRows = rows.filter((row) => row.header).length
        paginateTableRows(rows, contentHeight, { headerRows }).forEach((tablePage, index) => {
          result.push({
            block: sliceTableBlock(block, tablePage),
            height: Math.max(1, tablePage.height),
            breakBefore: index === 0,
          })
        })
        continue
      }
      result.push({
        block,
        height: blockHeights.get(block.docxIndex) ?? estimateHeight(block),
        breakBefore: block.format?.pageBreakBefore === true,
      })
    }
    return result
  }, [blocks, tableRows, blockHeights, contentHeight])

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
  const viewportHeight = viewport.current?.clientHeight || 720
  const range = visiblePages(tops, pageBoxHeights, scrollTop, viewportHeight, OVERSCAN)

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setScrollTop(element.scrollTop)
    if (!hasMore || loadingRef.current) return
    if (element.scrollTop + element.clientHeight > element.scrollHeight - 240) {
      if (session.current) void loadChunk(session.current, cursor)
    }
  }

  return (
    <div className="viewer-preview viewer-doc-remote">
      {name && <span className="viewer-doc-remote-name">{name}</span>}
      {status && <p className="viewer-status">{status}</p>}
      {error && (
        <div className="viewer-doc-remote-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => {
              if (session.current) void loadChunk(session.current, cursor)
              else void startSession()
            }}
          >
            重试
          </button>
        </div>
      )}
      <div className="viewer-doc-remote-viewport" ref={viewport} onScroll={onScroll}>
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
                <PageEditor
                  blocks={renderBlocks
                    .slice(page.blockStart, page.blockEnd)
                    .map((item) => item.block)}
                />
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
