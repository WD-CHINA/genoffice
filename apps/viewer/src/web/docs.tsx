import React, { useEffect, useState, useRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { setAltChunkHtmlConverter } from '@genoffice/docx-engine'
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
} from '@genoffice/viewer-renderers/docs/renderer/pagination'
import { hfReservedHeightPx } from '@genoffice/viewer-renderers/docs/renderer/editor/hf-dom'
import { hfHeaderGeom } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import { LocaleProvider } from '@genoffice/viewer-renderers/docs/renderer/i18n/locale'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'
import { api, post } from './api'
import {
  setContentPhased,
  waitForFullContent,
  cancelPhasedContent,
} from '@genoffice/viewer-renderers/docs/renderer/phased-content'

export function Docs({ session }: { session: string }) {
  const [parsed, setParsed] = useState<any>(null),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false)
  const conversionError = useRef<string | null>(null)
  const opening = useRef<{ session: string; promise: Promise<any> } | null>(null)
  const editor = useEditor({
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  useEffect(() => {
    if (!editor) return
    let cancelled = false
    setAltChunkHtmlConverter(async (html) => {
      try {
        const response = await fetch(`/api/view-sessions/${session}/altchunks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html }),
        })
        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error)
        }
        return new Uint8Array(await response.arrayBuffer())
      } catch (error) {
        conversionError.current = error instanceof Error ? error.message : String(error)
        throw error
      }
    })
    void (async () => {
      if (!opening.current || opening.current.session !== session) {
        conversionError.current = null
        opening.current = {
          session,
          promise: (async () => {
            const meta = await api(`view-sessions/${session}`)
            if (meta.locked) {
              const password = window.prompt('请输入 Word 打开密码')
              if (password === null) throw new Error('已取消密码输入')
              await post(`view-sessions/${session}/unlock`, { password })
            }
            const response = await fetch(`/api/view-sessions/${session}/content`)
            if (!response.ok) throw new Error('无法读取文档')
            return parseDocxOffThread(new Uint8Array(await response.arrayBuffer()), { owned: true })
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
      await document.fonts.ready
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      if (!cancelled) setReady(true)
    })().catch((e) => {
      if (!cancelled) setError(e.message)
    })
    return () => {
      cancelled = true
      cancelPhasedContent()
      setAltChunkHtmlConverter(null)
    }
  }, [editor, session])
  const layout = parsed && editor ? viewerLayout(parsed, editor) : null
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
  const box = layout ? sectionPageBox(layout.sections[0]?.settings || layout.section) : null
  const contentWidth = layout
    ? (layout.section.pageWidth - layout.section.marginLeft - layout.section.marginRight) / 15
    : 0
  const headerPx = layout
    ? hfReservedHeightPx(
        'header',
        header,
        contentWidth,
        parsed.headerImages,
        hfHeaderGeom(layout.section),
      )
    : 0
  const canvasTop = layout ? canvasContentTopPx(layout.sections, layout.section, headerPx) : 0
  const gridPitch = layout
    ? (docGridPitchPt(layout.sections) ??
      layout.sections.map(sectionGridPitchPt).find((p) => p != null))
    : null
  const charSpace = layout ? docCharSpacePt(layout.sections) : null
  return (
    <LocaleProvider initial="zh">
      <div className="viewer-doc">
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
            <div className="page-wrap" style={box ? { width: box.width } : undefined}>
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
        {layout && (
          <style>{`.viewer-doc-canvas .doc-page { width:${box!.width}px; --doc-margin-left:${layout.section.marginLeft / 15}px; --doc-margin-right:${layout.section.marginRight / 15}px; --doc-margin-top:${layout.section.marginTop / 15}px; padding:${canvasTop}px ${(layout!.sections[0]?.settings || layout!.section).marginRight / 15}px ${(layout!.sections[0]?.settings || layout!.section).marginBottom / 15}px ${(layout!.sections[0]?.settings || layout!.section).marginLeft / 15}px; box-sizing:border-box; }`}</style>
        )}
        {layout?.colFlow && (
          <style>{`.editor-scroll .doc-page { column-count:${layout.colFlow.cols}; column-gap:${layout.colFlow.gapPx}px; column-fill:balance } .editor-scroll .doc-page.measuring-columns { column-count:auto; width:${layout.colFlow.colWidthPx + (layout.sections[0]?.settings || layout.section).marginLeft / 15 + (layout.sections[0]?.settings || layout.section).marginRight / 15}px }`}</style>
        )}
        {ready && layout && (
          <PaginationPreview
            section={layout.section}
            canvasTop={canvasTop}
            sections={layout.sections}
            mirrorMargins={parsed.mirrorMargins}
            hfParts={parsed.hfParts || {}}
            colFlow={layout.colFlow}
            colMode={layout.colMode}
            hf={{
              header,
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
            resolveHf={(_, i, kind, variant) => resolveHf(hfState as any, i, kind, variant)}
            comments={parsed.comments}
            anchorBlocks={parsed.blocks}
            revisionView={editor!.view}
            onClose={() => {}}
            onExportPdf={() => {}}
            suppressEscape
          />
        )}
      </div>
    </LocaleProvider>
  )
}
