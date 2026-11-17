import { setDocFontTable } from '@genoffice/viewer-renderers/docs/renderer/text-layout/font-rules'
import React, { useEffect, useState, useRef, useMemo } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { parseLazyMediaUrl } from '@genoffice/docx-engine/lazy-media'
import {
  readPageColor,
  readSections,
  readSectionSettings,
  setAltChunkHtmlConverter,
  type DocxReadingContext,
} from '@genoffice/docx-engine'
import JSZip from 'jszip'
import {
  decryptDocx,
  DocxDecryptError,
  isEncryptedDocx,
} from '@genoffice/viewer-services/docs/decrypt'
import { parseDocxOffThread } from '@genoffice/viewer-renderers/docs/renderer/parse-off-thread'
import { setLazyMediaHashes } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import { viewerEditorOptions } from '@genoffice/viewer-renderers/docs/renderer/viewer-extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import { adoptEmbeddedFonts } from '@genoffice/viewer-renderers/docs/renderer/embedded-fonts'

import { applyDocLayoutSettings } from '@genoffice/viewer-renderers/docs/renderer/viewer-initialize'
import {
  docStyleCss,
  docThemeCss,
  docBodyFont,
} from '@genoffice/viewer-renderers/docs/renderer/doc-style-css'
import { LocaleProvider } from '@genoffice/viewer-renderers/docs/renderer/i18n/locale'
import {
  setContentPhased,
  waitForFullContent,
  cancelPhasedContent,
} from '@genoffice/viewer-renderers/docs/renderer/phased-content'
import { DocxReadingBar, DocxReadingHf, DocxReadingNotes, useDocxReadingZoom } from './docx-reading'
import { docxSectionTypography } from './docx-style-context'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'

export function Docs({ src }: { src: string }) {
  const [parsed, setParsed] = useState<any>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState('all')
  const viewport = useRef<HTMLDivElement>(null)
  const conversionError = useRef<string | null>(null)
  const opening = useRef<{ src: string; promise: Promise<any> } | null>(null)
  const editor = useEditor({
    ...viewerEditorOptions,
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
                  if (!(error instanceof DocxDecryptError) || error.reason !== 'wrong-password')
                    throw error
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
                  new Blob(
                    [
                      mediaBytes.buffer.slice(
                        mediaBytes.byteOffset,
                        mediaBytes.byteOffset + mediaBytes.byteLength,
                      ) as ArrayBuffer,
                    ],
                    {
                      type: mime[ext] || '',
                    },
                  ),
                )
                mediaUrls.set(key, url)
                return url
              }
              if (
                !value ||
                typeof value !== 'object' ||
                ArrayBuffer.isView(value) ||
                seen.has(value)
              )
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
        blocksToPmDoc(doc.blocks, readSections(doc), pmDocOptions(doc)),
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
    let cancelled = false
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    void (async () => {
      await frame()
      await frame()
      await document.fonts.ready
      if (!cancelled) setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [parsed])
  const context = useMemo<DocxReadingContext | undefined>(
    () =>
      parsed
        ? {
            sections: readSections(parsed),
            hfParts: parsed.hfParts ?? {},
            evenAndOddHeaders: !!parsed.evenOddHf,
            mirrorMargins: !!parsed.mirrorMargins,
            footnotes: parsed.footnotes ?? [],
            endnotes: parsed.endnotes ?? [],
            noteNumbers: parsed.noteNumbers ?? {},
            footnoteProps: parsed.footnoteProps,
            endnoteProps: parsed.endnoteProps,
          }
        : undefined,
    [parsed],
  )
  const section = parsed ? readSectionSettings(parsed) : undefined
  const width = section ? section.pageWidth / 15 : 794
  const controls = useDocxReadingZoom(viewport, width)
  const pageColor = parsed ? readPageColor(parsed) : null
  const follow = (event: React.MouseEvent) => {
    const link = (event.target as Element).closest('a')
    if (!link) return
    const href = link.getAttribute('href') ?? ''
    if (href.startsWith('#')) {
      event.preventDefault()
      try {
        const name = decodeURIComponent(href.slice(1))
        const target = viewport.current?.querySelector<HTMLElement>(
          `[data-bookmarks~="${CSS.escape(name)}"], [id="${CSS.escape(name)}"]`,
        )
        target?.scrollIntoView({ block: 'center' })
      } catch {
        /* Ignore malformed bookmark names. */
      }
    } else if (/^https?:|^mailto:/i.test(href)) {
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
    } else event.preventDefault()
  }
  return (
    <LocaleProvider initial="zh">
      <div
        className={`viewer-doc viewer-preview viewer-doc-reading read-mode rev-display-${revision === 'final' ? 'none' : revision}`}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && ['+', '=', '-'].includes(event.key)) {
            event.preventDefault()
            controls.changeZoom(event.key === '-' ? -1 : 1)
          }
        }}
      >
        {ready && (
          <DocxReadingBar controls={controls}>
            <label className="viewer-revision-control">
              修订
              <select
                aria-label="修订显示"
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
              >
                <option value="all">全部标记</option>
                <option value="final">最终版本</option>
                <option value="original">原始版本</option>
              </select>
            </label>
          </DocxReadingBar>
        )}
        {error && (
          <p role="alert" className="viewer-error">
            {error}
          </p>
        )}
        {!ready && !error && (
          <p className="viewer-status viewer-doc-status" role="status">
            正在加载文档…
          </p>
        )}
        {parsed && (
          <style data-doc-css>
            {docStyleCss(parsed) +
              docThemeCss(parsed.themeFonts, parsed.themeColors, !!docBodyFont(parsed))}
          </style>
        )}
        <div
          ref={viewport}
          className="viewer-doc-reading-scroll editor-scroll"
          tabIndex={0}
          onClick={follow}
        >
          {parsed && context && section && (
            <div className="doc-zoom" style={{ zoom: controls.zoom }}>
              <div
                className="page-wrap viewer-doc-reading-paper"
                style={{
                  width,
                  padding: `${section.marginTop / 15}px ${section.marginRight / 15}px ${section.marginBottom / 15}px ${section.marginLeft / 15}px`,
                  ...(pageColor ? { background: `#${pageColor}` } : {}),
                  ...docxSectionTypography(section),
                }}
              >
                <DocxReadingHf context={context} kind="header" />
                {parsed.watermark && (
                  <div className="page-watermark" aria-hidden="true">
                    {parsed.watermark}
                  </div>
                )}
                <div role="document" aria-label="Word 文档正文">
                  <EditorContent editor={editor} />
                </div>
                <DocxReadingNotes context={context} styles={parsed} />
                <DocxReadingHf context={context} kind="footer" />
              </div>
            </div>
          )}
        </div>
      </div>
    </LocaleProvider>
  )
}
