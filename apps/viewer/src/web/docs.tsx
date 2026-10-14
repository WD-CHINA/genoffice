import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { ToolbarIcon } from './toolbar-icon'
import { EditorContent, useEditor } from '@tiptap/react'
import { parseLazyMediaUrl } from '@genoffice/docx-engine/lazy-media'
import { readPageColor, setAltChunkHtmlConverter } from '@genoffice/docx-engine'
import JSZip from 'jszip'
import { decryptDocx, DocxDecryptError, isEncryptedDocx } from '@genoffice/viewer-services/docs/decrypt'
import { parseDocxOffThread } from '@genoffice/viewer-renderers/docs/renderer/parse-off-thread'
import {
  editorExtensions,
  setLazyMediaHashes,
} from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import { adoptEmbeddedFonts } from '@genoffice/viewer-renderers/docs/renderer/embedded-fonts'
import {
  setDocFontTable,
  cssFontFamily,
} from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import { applyDocLayoutSettings } from '@genoffice/viewer-renderers/docs/renderer/viewer-initialize'
import { viewerLayout } from '@genoffice/viewer-renderers/docs/renderer/viewer-layout'
import { PaginationPreview } from '@genoffice/viewer-renderers/docs/renderer/components/PaginationPreview'
import {
  docStyleCss,
  docThemeCss,
  docBodyFont,
} from '@genoffice/viewer-renderers/docs/renderer/doc-style-css'
import { hfVariantsFromParsed } from '@genoffice/viewer-renderers/docs/renderer/doc-state'
import { resolveHf } from '@genoffice/viewer-renderers/docs/renderer/hf-sections'
import {
  sectionPageBox,
  canvasContentTopPx,
  docGridPitchPt,
  docCharSpacePt,
  sectionGridPitchPt,
  paperWidthPx,
} from '@genoffice/viewer-renderers/docs/renderer/pagination'
import {
  hfReservedHeightPx,
  bumpHfProbeFontEpoch,
} from '@genoffice/viewer-renderers/docs/renderer/editor/hf-dom'
import { bumpLineSampleFontEpoch } from '@genoffice/viewer-renderers/docs/renderer/pagination-lines'
import { hfHeaderGeom } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import { LocaleProvider } from '@genoffice/viewer-renderers/docs/renderer/i18n/locale'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'
import { createViewerLayoutController } from '@genoffice/viewer-renderers/docs/renderer/viewer-layout-controller'
import {
  hfPhantomSpec,
  hfLayoutResolved,
  hfWithPhantom,
} from '@genoffice/viewer-renderers/docs/renderer/hf-phantom'
import {
  findDocMatches,
  paintDocMatches,
  scrollDocMatch,
  copyDocSelection,
  docPaintRect,
  type DocMatch,
} from './doc-search'
import {
  setContentPhased,
  waitForFullContent,
  cancelPhasedContent,
} from '@genoffice/viewer-renderers/docs/renderer/phased-content'

export function Docs({ src }: { src: string }) {
  const [parsed, setParsed] = useState<any>(null),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState(1),
    [fontEpoch, setFontEpoch] = useState(0),
    [pages, setPages] = useState(0),
    [currentPage, setCurrentPage] = useState(1),
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<DocMatch[]>([]),
    [matchIndex, setMatchIndex] = useState(0),
    [accessible, setAccessible] = useState(''),
    [navigation, setNavigation] = useState<{ title: string; idx: string }[]>([]),
    [revision, setRevision] = useState('all'),
    [fit, setFit] = useState<'width' | 'page' | null>(null)
  const container = useRef<HTMLDivElement>(null)
  const conversionError = useRef<string | null>(null)
  const opening = useRef<{ src: string; promise: Promise<any> } | null>(null)
  const editor = useEditor({
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  useEffect(() => {
    if (!editor) return
    let cancelled = false
    setAltChunkHtmlConverter(async () => {
      const message = '纯前端无法转换内嵌 HTML/MHT，这类内容需要服务端 Chrome。'
      conversionError.current = message
      throw new Error(message)
    })
    void (async () => {
      if (!opening.current || opening.current.src !== src) {
        conversionError.current = null
        opening.current = {
          src,
          promise: (async () => {
            const response = await fetch(src)
            if (!response.ok) throw new Error('无法读取文档')
            let bytes = new Uint8Array(await response.arrayBuffer())
            if (isEncryptedDocx(bytes)) {
              let unlocked = false
              while (!unlocked) {
                const password = window.prompt('请输入 Word 打开密码')
                if (password === null) throw new Error('已取消密码输入')
                try {
                  bytes = new Uint8Array(await decryptDocx(bytes, password))
                  unlocked = true
                } catch (error) {
                  if (!(error instanceof DocxDecryptError) || error.reason !== 'wrong-password') throw error
                  window.alert('密码不正确，请重试。')
                }
              }
            }
            const zip = await JSZip.loadAsync(bytes.slice())
            const mediaUrls = new Map<string, string>()
            const doc = await parseDocxOffThread(bytes, { owned: true })
            const rewriteMedia = async (value: any, seen = new Set<object>()): Promise<any> => {
              if (typeof value === 'string') {
                const ref = parseLazyMediaUrl(value)
                if (!ref) return value
                const key = ref.hash + '/' + ref.partPath
                const cached = mediaUrls.get(key)
                if (cached) return cached
                const file = zip.file(ref.partPath)
                if (!file) return value
                const ext = ref.partPath.split('.').pop()?.toLowerCase() || ''
                const mime: Record<string, string> = {
                  png: 'image/png',
                  jpg: 'image/jpeg',
                  jpeg: 'image/jpeg',
                  gif: 'image/gif',
                  bmp: 'image/bmp',
                  webp: 'image/webp',
                  svg: 'image/svg+xml',
                }
                const mediaBytes = await file.async('uint8array')
                const url = URL.createObjectURL(
                  new Blob([mediaBytes.buffer.slice(mediaBytes.byteOffset, mediaBytes.byteOffset + mediaBytes.byteLength) as ArrayBuffer], {
                    type: mime[ext] || '',
                  }),
                )
                mediaUrls.set(key, url)
                return url
              }
              if (!value || typeof value !== 'object' || ArrayBuffer.isView(value) || seen.has(value))
                return value
              seen.add(value)
              if (value instanceof Map) {
                for (const [key, item] of value) value.set(key, await rewriteMedia(item, seen))
              } else
                for (const key of Object.keys(value)) {
                  if (key !== 'internal') value[key] = await rewriteMedia(value[key], seen)
                }
              return value
            }
            await rewriteMedia(doc)
            return doc
          })(),
        }
      }
      const doc = await opening.current.promise
      if (conversionError.current) throw new Error('嵌入 HTML 转换失败：' + conversionError.current)
      if (cancelled) return
      setLazyMediaHashes(doc.extras.lazyMediaHashes)
      await adoptEmbeddedFonts(doc.embeddedFonts)
      setDocFontTable(doc.fontTable)
      editor.storage.listNumbering.styles = doc.styles
      editor.storage.listNumbering.docDefaults = doc.docDefaults
      editor.storage.listNumbering.defs = doc.numbering
      applyDocLayoutSettings(editor, doc)
      const layout = viewerLayout(doc, editor)
      setContentPhased(
        {
          setContent: (value) => {
            editor.commands.setContent(value as any, { emitUpdate: false })
          },
          appendNodes: (nodes) => {
            const fragment = editor.schema.nodeFromJSON({ type: 'doc', content: nodes }).content
            editor.view.dispatch(
              editor.state.tr
                .insert(editor.state.doc.content.size, fragment)
                .setMeta('addToHistory', false),
            )
          },
          isDestroyed: () => cancelled || editor.isDestroyed,
          resetHistory: () => {},
          setLoading: () => {},
          getDirty: () => false,
          setDirty: () => {},
        },
        blocksToPmDoc(doc.blocks, layout.sections, pmDocOptions(doc)),
      )
      await waitForFullContent()
      if (cancelled) return
      editor.setEditable(false)
      setParsed(doc)
    })().catch((e) => {
      if (!cancelled) setError(e.message)
    })
    return () => {
      cancelled = true
      cancelPhasedContent()
      setAltChunkHtmlConverter(null)
    }
  }, [editor, src])
  useEffect(() => {
    if (!parsed) return
    let stopped = false,
      generation = 0,
      signature: string | undefined,
      timer: ReturnType<typeof setTimeout> | undefined
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const settle = async () => {
      const current = ++generation
      // Parsed document styles must commit and initiate font loads before ready is read.
      await frame()
      await frame()
      await document.fonts.ready
      await frame()
      await frame()
      if (stopped || current !== generation) return
      const next = [...document.fonts]
        .map((face) => `${face.family}|${face.weight}|${face.style}|${face.status}`)
        .sort()
        .join('\n')
      if (signature === next) return
      signature = next
      bumpLineSampleFontEpoch()
      bumpHfProbeFontEpoch()
      setFontEpoch((value) => value + 1)
      setReady(true)
    }
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void settle(), 300)
    }
    setReady(false)
    void settle()
    document.fonts.addEventListener('loadingdone', changed)
    document.fonts.addEventListener('loadingerror', changed)
    return () => {
      stopped = true
      clearTimeout(timer)
      document.fonts.removeEventListener('loadingdone', changed)
      document.fonts.removeEventListener('loadingerror', changed)
    }
  }, [parsed])
  const layout = useMemo(
    () => (parsed && editor ? viewerLayout(parsed, editor) : null),
    [parsed, editor, fontEpoch],
  )
  const pageColor = parsed ? readPageColor(parsed) : null
  const phantom = parsed && pageColor ? hfPhantomSpec(parsed) : null
  const controller = useMemo(
    () =>
      editor && layout
        ? createViewerLayoutController(
            editor.view,
            layout.colMode === 'mixed',
            !!parsed.mirrorMargins,
            () => setError('文档布局尚未稳定，请核对复杂分栏和浮动对象的位置。'),
          )
        : undefined,
    [editor, layout, parsed, revision],
  )
  const variants = parsed ? hfVariantsFromParsed(parsed) : null
  const header = parsed
    ? {
        text: parsed.headerText || '',
        paras: parsed.headerParas,
        pageNumber: parsed.headerHasPageNumber,
      }
    : null
  const footer = parsed
    ? {
        text: parsed.footerText || '',
        paras: parsed.footerParas,
        pageNumber: parsed.footerHasPageNumber,
      }
    : null
  const hfState = layout
    ? {
        sections: layout.sections,
        edits: {},
        links: {},
        parsed,
        docStrips: { header, footer, variants },
      }
    : null
  const canvasSection = layout ? layout.sections[0]?.settings || layout.section : null
  const box = canvasSection ? sectionPageBox(canvasSection) : null
  const paperWidth = layout ? paperWidthPx(layout.sections, canvasSection!) : 0
  const paperHeight = layout
    ? Math.max(
        ...layout.sections.map((section) => sectionPageBox(section.settings).height),
        box!.height,
      )
    : 0
  const contentWidth = box?.contentWidth || 0
  const headerPx = layout
    ? hfReservedHeightPx(
        'header',
        phantom ? hfWithPhantom(header, phantom, parsed.headerImages) : header,
        contentWidth,
        parsed.headerImages,
        hfHeaderGeom(canvasSection!),
      )
    : 0
  const canvasTop = layout ? canvasContentTopPx(layout.sections, canvasSection!, headerPx) : 0
  const gridPitch = layout
    ? (docGridPitchPt(layout.sections) ??
      layout.sections.map(sectionGridPitchPt).find((p) => p != null))
    : null
  const charSpace = layout ? docCharSpacePt(layout.sections) : null
  const onReady = useCallback((count: number, html: string) => {
    setMatches([])
    paintDocMatches([], 0)
    setPages(count)
    const host = document.createElement('div')
    host.innerHTML = html
    for (const element of host.querySelectorAll<HTMLElement>('*')) {
      element.removeAttribute('style')
      if (element instanceof HTMLAnchorElement) element.removeAttribute('tabindex')
    }
    setAccessible(host.innerHTML)
    setNavigation(
      [...host.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,[data-bookmarks]')]
        .map((el) => ({
          title: el.textContent?.trim() || el.dataset.bookmarks || '',
          idx: el.dataset.idx || '',
        }))
        .filter((row) => row.title && row.idx),
    )
  }, [])
  const goPage = (value: number) => {
    const next = Math.max(1, Math.min(pages, value))
    container.current
      ?.querySelector(`[data-pv-page="${next - 1}"]`)
      ?.scrollIntoView({ block: 'start' })
    setCurrentPage(next)
  }
  const goBlock = (idx: string) => {
    const elements =
      container.current?.querySelectorAll<HTMLElement>(
        `.pv-content [data-idx="${CSS.escape(idx)}"]`,
      ) || []
    for (const el of elements) {
      const sheet = el.closest<HTMLElement>('.pv-page')
      if (!sheet) continue
      const rect = docPaintRect(el),
        scroll = el.closest<HTMLElement>('.pv-scroll')
      if (rect && scroll) {
        scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2
        setCurrentPage(Number(sheet.dataset.pvPage) + 1)
        return
      }
    }
  }
  const search = () => {
    const found = container.current ? findDocMatches(container.current, query.trim()) : []
    setMatches(found)
    setMatchIndex(0)
    paintDocMatches(found, 0)
    scrollDocMatch(found[0])
  }
  const stepMatch = (delta: number) => {
    if (!matches.length) return
    const next = (matchIndex + delta + matches.length) % matches.length
    setMatchIndex(next)
    paintDocMatches(matches, next)
    scrollDocMatch(matches[next])
  }
  useEffect(() => {
    if (!fit || !container.current || !box) return
    const element = container.current
    const update = () =>
      setZoom(
        Math.max(
          0.25,
          Math.min(
            3,
            fit === 'width'
              ? (element.clientWidth - 48) / paperWidth
              : Math.min(
                  (element.clientWidth - 48) / paperWidth,
                  (element.clientHeight - 56) / paperHeight,
                ),
          ),
        ),
      )
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [fit, paperWidth, paperHeight])
  const follow = (event: React.MouseEvent) => {
    const a = (event.target as Element).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (href.startsWith('#')) {
      event.preventDefault()
      let name = href.slice(1)
      try {
        name = decodeURIComponent(name)
      } catch {
        return
      }
      const el = container.current?.querySelector<HTMLElement>(
        `.pv-content [data-bookmarks~="${CSS.escape(name)}"]`,
      )
      if (el?.dataset.idx) goBlock(el.dataset.idx)
    } else if (!/^https?:|^mailto:/i.test(href)) event.preventDefault()
    else {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
  }
  return (
    <LocaleProvider initial="zh">
      <div
        className={`viewer-doc viewer-preview rev-display-${revision === 'final' ? 'none' : revision}${revision === 'all' ? ' rev-balloon' : ''}`}
        onKeyDown={(event) => {
          const command = event.ctrlKey || event.metaKey
          const searchInput =
            event.currentTarget.querySelector<HTMLInputElement>('[aria-label="搜索 Word"]')
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
            setFit(null)
            setZoom((value) =>
              Math.max(0.25, Math.min(3, value + (event.key === '-' ? -0.1 : 0.1))),
            )
          } else if (
            !(event.target as Element).closest('input,textarea,select') &&
            ['PageUp', 'PageDown'].includes(event.key)
          ) {
            event.preventDefault()
            goPage(currentPage + (event.key === 'PageUp' ? -1 : 1))
          }
        }}
      >
        {ready && (
          <header className="viewer-bar">
            <div className="viewer-toolbar-group" role="group" aria-label="Word 页面导航">
              <button disabled={currentPage <= 1} onClick={() => goPage(currentPage - 1)}>
                <ToolbarIcon name="previous" />
                上一页
              </button>
              <label>
                页码
                <input
                  aria-label="Word 页码"
                  type="number"
                  min="1"
                  max={pages}
                  value={currentPage}
                  onChange={(e) => goPage(Number(e.target.value))}
                />
              </label>
              <span className="viewer-page-count">/ {pages}</span>
              <button disabled={currentPage >= pages} onClick={() => goPage(currentPage + 1)}>
                下一页
                <ToolbarIcon name="next" />
              </button>
            </div>
            <div className="viewer-toolbar-group" role="group" aria-label="Word 缩放">
              <button
                onClick={() => {
                  setFit(null)
                  setZoom((z) => Math.max(0.25, z - 0.1))
                }}
              >
                <ToolbarIcon name="minus" />
                缩小
              </button>
              <button
                onClick={() => {
                  setFit(null)
                  setZoom((z) => Math.min(3, z + 0.1))
                }}
              >
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
            <div className="viewer-search-controls" hidden>
              <input
                aria-label="搜索 Word"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') search()
                }}
              />
              <button onClick={search}>搜索</button>
              <span>{matches.length ? `${matchIndex + 1}/${matches.length}` : '无匹配'}</span>
              <button onClick={() => stepMatch(-1)}>上一处</button>
              <button onClick={() => stepMatch(1)}>下一处</button>
            </div>
            <label className="viewer-revision-control viewer-toolbar-end">
              修订
              <select
                aria-label="修订显示"
                value={revision}
                onChange={(e) => setRevision(e.target.value)}
              >
                <option value="all">全部标记</option>
                <option value="final">最终版本</option>
                <option value="original">原始版本</option>
              </select>
            </label>
          </header>
        )}
        {error && (
          <p role="alert" className="viewer-error">
            {error}
          </p>
        )}
        {!ready && !error && <p>正在解析和分页…</p>}
        {parsed && (
          <style data-doc-css>
            {docStyleCss(parsed) +
              docThemeCss(parsed.themeFonts, parsed.themeColors, !!docBodyFont(parsed))}
          </style>
        )}
        {gridPitch != null && <style>{`.doc-page { --doc-grid-pitch:${gridPitch}pt }`}</style>}
        {charSpace != null && (
          <style>{`.doc-page { --doc-char-space:${Math.round(charSpace * 10000) / 10000}pt }`}</style>
        )}
        <div className="viewer-doc-canvas editor-scroll">
          <div className="doc-zoom" style={{ zoom: 1 }}>
            <div className="page-wrap" style={box ? { width: paperWidth } : undefined}>
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
        {layout && (
          <style>{`.viewer-doc-canvas .doc-page { width:${paperWidth}px; --page-w:${paperWidth}px; --section-content-w:${contentWidth}px; --doc-margin-left:${canvasSection!.marginLeft / 15}px; --doc-margin-right:${canvasSection!.marginRight / 15}px; --doc-margin-top:${canvasSection!.marginTop / 15}px; ${pageColor ? `--page-bg:#${pageColor};` : ''} padding:${canvasTop}px ${canvasSection!.marginRight / 15}px ${canvasSection!.marginBottom / 15}px ${canvasSection!.marginLeft / 15}px; box-sizing:border-box; }`}</style>
        )}
        {layout?.colFlow && (
          <style>{`.editor-scroll .doc-page { column-count:${layout.colFlow.cols}; column-gap:${layout.colFlow.gapPx}px; column-fill:balance } .editor-scroll .doc-page.measuring-columns { column-count:auto; width:${layout.colFlow.colWidthPx + (layout.sections[0]?.settings || layout.section).marginLeft / 15 + (layout.sections[0]?.settings || layout.section).marginRight / 15}px }`}</style>
        )}
        {ready && layout && (
          <div className="viewer-reading-body">
            <aside className="viewer-navigation">
              <strong>标题与书签</strong>
              {navigation.map((row, i) => (
                <button key={i} onClick={() => goBlock(row.idx)}>
                  {row.title}
                </button>
              ))}
              {parsed.comments?.map((comment: any, i: number) => (
                <details key={`c${i}`}>
                  <summary>{comment.author || '批注'}</summary>
                  <button
                    onClick={() => {
                      const span = container.current?.querySelector<HTMLElement>(
                        `.pv-content [data-comment-ids~="${CSS.escape(String(comment.id))}"]`,
                      )
                      const idx = span?.closest<HTMLElement>('[data-idx]')?.dataset.idx
                      if (idx) goBlock(idx)
                    }}
                  >
                    定位批注
                  </button>
                  <p>
                    {comment.text ||
                      comment.paras
                        ?.flat()
                        .map((r: any) => r.text)
                        .join('')}
                  </p>
                </details>
              ))}
            </aside>
            <div
              ref={container}
              className="viewer-doc-pages"
              onClick={follow}
              onCopy={(event) => copyDocSelection(event.currentTarget, event)}
              onScrollCapture={(event) => {
                const scroll = event.target as HTMLElement
                if (!scroll.classList.contains('pv-scroll')) return
                const viewport = scroll.getBoundingClientRect()
                const sheets = [...scroll.querySelectorAll<HTMLElement>('.pv-page')]
                const visibleHeight = (page: HTMLElement) => {
                  const r = page.getBoundingClientRect()
                  return Math.max(
                    0,
                    Math.min(r.bottom, viewport.bottom) - Math.max(r.top, viewport.top),
                  )
                }
                const nearest = sheets.reduce<HTMLElement | null>(
                  (best, page) =>
                    !best || visibleHeight(page) > visibleHeight(best) ? page : best,
                  null,
                )
                if (nearest) setCurrentPage(Number(nearest.dataset.pvPage) + 1)
              }}
            >
              <div
                className="viewer-doc-a11y"
                role="document"
                aria-label="Word 文档正文"
                onFocusCapture={(event) => {
                  const anchor = (event.target as HTMLElement).closest('a')
                  if (!anchor) return
                  for (const el of container.current?.querySelectorAll<HTMLElement>(
                    '.pv-content a',
                  ) || []) {
                    const rect = docPaintRect(el)
                    if (el.getAttribute('href') !== anchor.getAttribute('href') || !rect) continue
                    el.dataset.viewerFocus = 'true'
                    const scroll = el.closest<HTMLElement>('.pv-scroll')!
                    scroll.scrollTop +=
                      rect.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2
                    break
                  }
                }}
                onBlurCapture={() => {
                  for (const el of container.current?.querySelectorAll<HTMLElement>(
                    '[data-viewer-focus]',
                  ) || [])
                    delete el.dataset.viewerFocus
                }}
                dangerouslySetInnerHTML={{ __html: accessible }}
              />
              <style>{`.viewer-doc-pages .pv-page { zoom:${zoom}; ${pageColor ? `background:#${pageColor};` : ''} } .viewer-doc-pages .pv-toolbar { display:none }`}</style>
              <PaginationPreview
                key={`${revision}:${fontEpoch}`}
                reading
                onLayout={controller}
                onReady={onReady}
                section={layout.section}
                canvasTop={canvasTop}
                sections={layout.sections}
                mirrorMargins={parsed.mirrorMargins}
                hfParts={parsed.hfParts || {}}
                colFlow={layout.colFlow}
                colMode={layout.colMode}
                hf={{
                  header: phantom ? hfWithPhantom(header, phantom, parsed.headerImages) : header,
                  footer,
                  ...variants!,
                  titlePg: parsed.titlePg,
                  evenOddHf: parsed.evenOddHf,
                  images: {
                    header: parsed.headerImages,
                    footer: parsed.footerImages,
                    headerFirst: parsed.headerFirst?.images,
                    footerFirst: parsed.footerFirst?.images,
                    headerEven: parsed.headerEven?.images,
                    footerEven: parsed.footerEven?.images,
                  },
                }}
                watermark={parsed.watermark || null}
                blockMetaOf={layout.blockMetaOf}
                pageFootnotesOf={layout.pageFootnotesOf}
                footnotesBeneathText={parsed.footnoteProps?.pos === 'beneathText'}
                endnoteItems={layout.endnoteItems}
                resolveHf={(_, i, kind, variant) =>
                  hfLayoutResolved(kind, resolveHf(hfState as any, i, kind, variant), phantom)
                }
                comments={revision === 'all' ? parsed.comments : []}
                anchorBlocks={parsed.blocks}
                revisionView={revision === 'all' ? editor!.view : null}
                onClose={() => {}}
                onExportPdf={() => {}}
                suppressEscape
              />
            </div>
          </div>
        )}
      </div>
    </LocaleProvider>
  )
}
