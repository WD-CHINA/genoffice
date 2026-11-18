import { useDocxPageWindow } from './docx-page-window'
import { useDocxDisplayPosition, type DocxDisplayPosition } from './docx-display-position'
import { measureDocxPages } from './docx-page-pass'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { EditorContent } from '@tiptap/react'
import { readPageColor, readSections, type ParsedDocFull } from '@genoffice/docx-engine'
import { viewerLayout } from '@genoffice/viewer-renderers/docs/renderer/viewer-layout'
import { PaginationPreview } from '@genoffice/viewer-renderers/docs/renderer/components/PaginationPreview'
import { HeaderFooterArea } from '@genoffice/viewer-renderers/docs/renderer/components/HeaderFooterArea'
import {
  hfVariantsFromParsed,
  restingHfAreaVariant,
} from '@genoffice/viewer-renderers/docs/renderer/doc-state'
import { resolveHf } from '@genoffice/viewer-renderers/docs/renderer/hf-sections'
import { hfReservedHeightPx } from '@genoffice/viewer-renderers/docs/renderer/editor/hf-dom'
import { hfHeaderGeom } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import {
  sectionPageBox,
  canvasContentTopPx,
  pageNumbers,
  sectionPageCounts,
  pageOfY,
  type BlockBox,
  type PageSlice,
  type SectionGeom,
} from '@genoffice/viewer-renderers/docs/renderer/pagination'
import { formatPageNumber } from '@genoffice/viewer-renderers/docs/renderer/pagination-hf'
import { createViewerLayoutController } from '@genoffice/viewer-renderers/docs/renderer/viewer-layout-controller'
import { collectHeadings } from '@genoffice/viewer-renderers/docs/renderer/editor/headings'
import { applyTocPageDisplays } from '@genoffice/viewer-renderers/docs/renderer/editor/toc-refresh'
import { TRACK_IGNORE } from '@genoffice/viewer-renderers/docs/renderer/editor/revisions'
import { DocxPageBar, useDocxPageZoom } from './docx-page-controls'
import { docxReadingPageVars } from './docx-reading-page'

/** Original layout/preview/strips shared by local bytes and the actual HTTP model. */
export function DocxDisplay({
  parsed,
  editor,
  ready,
  revision,
  children,
  position,
}: {
  parsed: ParsedDocFull
  editor: Editor
  ready: boolean
  revision: string
  children?: React.ReactNode
  position?: DocxDisplayPosition
}) {
  const root = useRef<HTMLDivElement>(null)
  const [pages, setPages] = useState(1)
  const [epoch, setEpoch] = useState(0)
  const [edge, setEdge] = useState({ first: '1', last: '1', firstCount: 1, lastCount: 1 })
  const color = readPageColor(parsed)
  const watermark = (parsed as ParsedDocFull & { watermark?: string }).watermark
  // These helpers cache font-dependent header/note probes; rebuild after font or DOM changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => viewerLayout(parsed, editor), [parsed, editor, ready, epoch])
  const sections = useMemo(() => readSections(parsed), [parsed]),
    section = sections[0]?.settings ?? layout.section
  const box = sectionPageBox(section)
  const controls = useDocxPageZoom(root, box.width, ready)
  const visiblePages = useDocxPageWindow(root, pages, epoch, ready)
  const header = {
    text: parsed.headerText ?? '',
    paras: parsed.headerParas ?? undefined,
    pageNumber: parsed.headerHasPageNumber,
  }
  const footer = {
    text: parsed.footerText ?? '',
    paras: parsed.footerParas ?? undefined,
    pageNumber: parsed.footerHasPageNumber,
  }
  const variants = hfVariantsFromParsed(parsed)
  const resolved = useCallback(
    (index: number, kind: 'header' | 'footer', variant: 'default' | 'first' | 'even') =>
      resolveHf(
        {
          sections,
          edits: {},
          links: {},
          parsed,
          docStrips: {
            header: {
              text: parsed.headerText ?? '',
              paras: parsed.headerParas ?? undefined,
              pageNumber: parsed.headerHasPageNumber,
            },
            footer: {
              text: parsed.footerText ?? '',
              paras: parsed.footerParas ?? undefined,
              pageNumber: parsed.footerHasPageNumber,
            },
            variants: hfVariantsFromParsed(parsed),
          },
        } as any,
        index,
        kind,
        variant,
      ),
    [sections, parsed],
  )
  const first = resolved(0, 'header', section && sections[0]?.titlePg ? 'first' : 'default')
  const reserve = hfReservedHeightPx(
    'header',
    first.value,
    box.contentWidth,
    first.images,
    hfHeaderGeom(section),
  )
  const top = canvasContentTopPx(sections, section, reserve)
  const controller = useMemo(
    () =>
      createViewerLayoutController(editor.view, layout.colMode === 'mixed', !!parsed.mirrorMargins),
    [editor, layout, parsed],
  )
  const onLayout = useCallback(
    (blocks: BlockBox[], slices: PageSlice[], secs: typeof sections, geoms: SectionGeom[]) => {
      if (controller(blocks, slices, secs, geoms)) return true
      // App.tsx's heading-page backfill, using the preview clone's matching source indices.
      const nums = pageNumbers(slices, secs)
      const byIndex = new Map(blocks.filter((b) => b.el).map((b) => [b.el!.dataset.idx, b.top]))
      const headings = collectHeadings(editor.state.doc, parsed.styles)
      const displays = headings.map((h) => {
        const dom = editor.view.nodeDOM(h.pos) as HTMLElement | null
        const y = dom ? byIndex.get(dom.dataset.idx) : undefined
        if (y === undefined) return undefined
        const i = Math.max(0, Math.min(slices.length - 1, pageOfY(slices, y)))
        return formatPageNumber(nums[i] ?? i + 1, secs[slices[i]?.section ?? 0]?.pageNumberFmt)
      })
      const tr = editor.state.tr
      if (applyTocPageDisplays(editor.state.doc, tr, headings, displays)) {
        editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta(TRACK_IGNORE, true))
        setEpoch((v) => v + 1)
      }
      return false
    },
    [controller, editor, parsed],
  )
  const cached = useRef<
    { doc: typeof editor.state.doc; page: ReturnType<typeof measureDocxPages> } | undefined
  >(undefined)
  const getLayout = useCallback(
    (fresh = false) => {
      if (!fresh && cached.current?.doc === editor.state.doc) return cached.current.page
      let result = measureDocxPages(editor, parsed, layout, top, resolved)
      for (let i = 0; i < 12; i++) {
        const before = editor.state.doc
        const changed = onLayout(result.blocks, result.slices, sections, result.geoms)
        if (!changed && before === editor.state.doc) break
        result = measureDocxPages(editor, parsed, layout, top, resolved)
      }
      const numbers = pageNumbers(result.slices, sections),
        counts = sectionPageCounts(result.slices),
        last = result.slices.length - 1
      const edgeValue = (i: number) =>
        formatPageNumber(
          numbers[i] ?? i + 1,
          sections[result.slices[i]?.section ?? 0]?.pageNumberFmt,
        )
      const next = {
        first: edgeValue(0),
        last: edgeValue(last),
        firstCount: counts[0] ?? 1,
        lastCount: counts[last] ?? 1,
      }
      setEdge((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next))
      cached.current = { doc: editor.state.doc, page: result }
      return result
    },
    [editor, parsed, layout, top, onLayout, sections, resolved],
  )
  const locate = useCallback(
    (index: number) => {
      const layout = getLayout()
      const block = layout.blocks.find((block) => Number(block.el?.dataset.idx) === index)
      return block ? pageOfY(layout.slices, block.top) : undefined
    },
    [getLayout],
  )
  useDocxDisplayPosition(root, position, ready, pages, controls.zoom, visiblePages, locate)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let signature = ''
    const changed = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        const root = editor.view.dom,
          rect = root.getBoundingClientRect()
        const next = [
          rect.width,
          rect.height,
          ...[...root.querySelectorAll('img')].flatMap((image) => [
            image.naturalWidth,
            image.naturalHeight,
          ]),
          document.fonts.status,
        ].join('|')
        if (signature === next) return
        signature = next
        cached.current = undefined
        setEpoch((value) => value + 1)
      }, 100)
    }
    const observer = new ResizeObserver(changed)
    observer.observe(editor.view.dom)
    editor.view.dom.addEventListener('load', changed, true)
    document.fonts.addEventListener('loadingdone', changed)
    return () => {
      observer.disconnect()
      clearTimeout(timer)
      editor.view.dom.removeEventListener('load', changed, true)
      document.fonts.removeEventListener('loadingdone', changed)
    }
  }, [editor])
  const strip = (kind: 'header' | 'footer') => {
    const index = kind === 'header' ? 0 : sections.length - 1
    const variant = restingHfAreaVariant(kind, {
      titlePg: !!sections[index]?.titlePg,
      evenOddHf: !!parsed.evenAndOddHeaders,
      pageCount: pages,
      lastPageNo: Number(edge.last) || pages,
    })
    const part = resolved(index, kind, variant)
    return part.value ? (
      <HeaderFooterArea
        kind={kind}
        value={part.value}
        images={part.images}
        readOnly
        onCommit={() => {}}
        pageNo={kind === 'header' ? edge.first : edge.last}
        pageTotal={pages}
        sectionPages={kind === 'header' ? edge.firstCount : edge.lastCount}
      />
    ) : null
  }
  return (
    <div ref={root} className="viewer-doc-surface">
      {ready && <DocxPageBar controls={controls}>{children}</DocxPageBar>}
      <div className="viewer-doc-electron-source viewer-doc-measure-source" aria-hidden="true">
        <div className="viewer-doc-measure-scroll editor-scroll">
          <div className="doc-zoom" style={{ zoom: 1 }}>
            <div
              className="page-wrap"
              style={
                {
                  width: box.width,
                  ...(color ? { backgroundColor: '#' + color } : {}),
                  ...docxReadingPageVars(section),
                  '--page-pad': `${top}px ${section.marginRight / 15}px ${section.marginBottom / 15}px ${section.marginLeft / 15}px`,
                  '--page-mt': `${top}px`,
                } as React.CSSProperties
              }
            >
              {strip('header')}
              {watermark && (
                <div className="page-watermark" aria-hidden="true">
                  {watermark}
                </div>
              )}
              <div role="document" aria-label="Word 文档正文">
                <EditorContent editor={editor} />
              </div>
              {strip('footer')}
            </div>
          </div>
        </div>
      </div>
      {ready && (
        <div
          className="viewer-doc-pages"
          role="document"
          aria-label="Word 文档正文"
          contentEditable={false}
        >
          <style>{`.viewer-doc-pages .pv-page { zoom:${controls.zoom}; ${color ? 'background:#' + color + ';' : ''} } .viewer-doc-pages .pv-toolbar, .viewer-doc-pages .pv-pageno { display:none }`}</style>
          <PaginationPreview
            visiblePages={visiblePages}
            key={`${revision}:${epoch}`}
            reading
            pruneClones
            layout={getLayout}
            onLayout={onLayout}
            onReady={(count) => setPages(count)}
            section={layout.section}
            canvasTop={top}
            sections={sections}
            mirrorMargins={parsed.mirrorMargins}
            hfParts={parsed.hfParts ?? {}}
            colFlow={layout.colFlow}
            colMode={layout.colMode}
            hf={{
              header,
              footer,
              ...variants,
              titlePg: !!parsed.titlePg,
              evenOddHf: !!parsed.evenAndOddHeaders,
              images: {
                header: parsed.headerImages ?? undefined,
                footer: parsed.footerImages ?? undefined,
                headerFirst: parsed.headerFirst?.images,
                footerFirst: parsed.footerFirst?.images,
                headerEven: parsed.headerEven?.images,
                footerEven: parsed.footerEven?.images,
              },
            }}
            blockMetaOf={layout.blockMetaOf}
            footnotesBeneathText={parsed.footnoteProps?.pos === 'beneathText'}
            endnoteItems={layout.endnoteItems}
            resolveHf={(_, i, kind, variant) => resolved(i, kind, variant)}
            comments={revision === 'all' ? parsed.comments : []}
            anchorBlocks={parsed.blocks}
            revisionView={revision === 'all' ? editor.view : null}
            onClose={() => {}}
            onExportPdf={() => {}}
            suppressEscape
          />
        </div>
      )}
    </div>
  )
}
