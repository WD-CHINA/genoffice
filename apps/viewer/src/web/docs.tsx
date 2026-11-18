import { collectDocFonts } from '@genoffice/viewer-renderers/docs/renderer/font-check'
import { loadBundledStandIns } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import { applyDocxGridCompat } from './docx-grid-compat'
import { createDocxImageScope } from './docx-image-scope'
import { createDocxNativeFonts } from './docx-native-fonts'
import { docxDocumentTypography } from './docx-style-context'
import type { DocxDisplayPosition } from './docx-display-position'
import { DocxDisplay } from './docx-display'
import { createWordPasswordDialog } from './word-password'
import { PHASED_APPEND } from '@genoffice/viewer-renderers/docs/renderer/editor/streaming-tail-guard'
import { TRACK_IGNORE } from '@genoffice/viewer-renderers/docs/renderer/editor/revisions'
import { TABLE_TRAILING_SKIP } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import { setDocFontTable } from '@genoffice/viewer-renderers/docs/renderer/text-layout/font-rules'
import React, { useEffect, useState, useRef } from 'react'
import { useEditor } from '@tiptap/react'
import { parseLazyMediaUrl } from '@genoffice/docx-engine/lazy-media'
import { readSections, setAltChunkHtmlConverter } from '@genoffice/docx-engine'
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
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'

export function Docs({
  src,
  name,
  model,
  position,
}: {
  src: string
  name?: string
  model?: any
  position?: DocxDisplayPosition
}) {
  const [parsed, setParsed] = useState<any>(null)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState('all')
  const nativeFonts = useRef<ReturnType<typeof createDocxNativeFonts> | null>(null)
  const conversionError = useRef<string | null>(null)
  const opening = useRef<{ src: string; promise: Promise<any>; signal: AbortSignal } | null>(null)
  const editor = useEditor({
    ...viewerEditorOptions,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  useEffect(() => {
    if (!editor) return
    let cancelled = false
    const controller = new AbortController()
    const images = createDocxImageScope()
    const fonts = createDocxNativeFonts()
    nativeFonts.current = fonts
    setReady(false)
    setError('')
    setAltChunkHtmlConverter(async () => {
      const message = '纯前端无法转换内嵌 HTML/MHT，这类内容需要服务端 Chrome。'
      conversionError.current = message
      throw new Error(message)
    })
    void (async () => {
      if (!opening.current || opening.current.src !== src || opening.current.signal.aborted) {
        conversionError.current = null
        opening.current = {
          src,
          signal: controller.signal,
          promise: (async () => {
            if (model) return model
            const response = await fetch(src)
            if (!response.ok) throw new Error('无法读取文档')
            let bytes = new Uint8Array(await response.arrayBuffer())
            if (isEncryptedDocx(bytes)) {
              const dialog = createWordPasswordDialog(name, controller.signal)
              let wrong = false
              try {
                for (;;) {
                  const password = await dialog.ask(wrong)
                  if (password === null) throw new Error('已取消密码输入')
                  try {
                    bytes = new Uint8Array(await decryptDocx(bytes, password))
                    if (dialog.cancelled) throw new Error('已取消密码输入')
                    break
                  } catch (error) {
                    if (!(error instanceof DocxDecryptError) || error.reason !== 'wrong-password')
                      throw error
                    wrong = true
                  }
                }
              } finally {
                dialog.close()
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
      images.adopt(doc)
      setLazyMediaHashes(doc.extras.lazyMediaHashes)
      await adoptEmbeddedFonts(doc.embeddedFonts)
      setDocFontTable(doc.fontTable)
      const declaredFonts = collectDocFonts(doc)
      await fonts.loadFamilies(declaredFonts)
      await loadBundledStandIns(declaredFonts)
      if (cancelled) return
      editor.storage.listNumbering.styles = doc.styles
      editor.storage.listNumbering.docDefaults = doc.docDefaults
      editor.storage.listNumbering.defs = doc.numbering
      applyDocLayoutSettings(editor, doc)
      setContentPhased(
        {
          setContent: (value) => {
            editor
              .chain()
              .setMeta('addToHistory', false)
              .setMeta(TRACK_IGNORE, true)
              .setMeta(TABLE_TRAILING_SKIP, true)
              .setMeta(PHASED_APPEND, true)
              .setContent(value as any, { emitUpdate: false })
              .run()
          },
          appendNodes: (nodes) => {
            const fragment = editor.schema.nodeFromJSON({ type: 'doc', content: nodes }).content
            editor.view.dispatch(
              editor.state.tr
                .insert(editor.state.doc.content.size, fragment)
                .setMeta('addToHistory', false)
                .setMeta(PHASED_APPEND, true)
                .setMeta(TRACK_IGNORE, true)
                .setMeta(TABLE_TRAILING_SKIP, true),
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
      controller.abort()
      images.close()
      fonts.close()
      if (nativeFonts.current === fonts) nativeFonts.current = null
      cancelPhasedContent()
      setAltChunkHtmlConverter(null)
    }
  }, [editor, src, name, model])
  useEffect(() => {
    if (!parsed) return
    let cancelled = false
    const fonts = nativeFonts.current
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    void (async () => {
      await frame()
      await frame()
      await document.fonts.ready
      if (editor)
        await fonts?.load(editor.view.dom.closest<HTMLElement>('.page-wrap') ?? editor.view.dom)
      if (!cancelled) {
        if (editor) applyDocxGridCompat(editor.view.dom)
        setReady(true)
      }
    })().catch((error) => {
      if (!cancelled) setError(error.message)
    })
    return () => {
      cancelled = true
    }
  }, [parsed, editor])
  return (
    <LocaleProvider initial="zh">
      <div
        className={`viewer-doc viewer-preview rev-display-${revision === 'final' ? 'none' : revision}`}
      >
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
              docThemeCss(parsed.themeFonts, parsed.themeColors, !!docBodyFont(parsed)) +
              docxDocumentTypography(parsed)}
          </style>
        )}
        {parsed && editor && (
          <DocxDisplay
            parsed={parsed}
            editor={editor}
            ready={ready}
            revision={revision}
            position={position}
          >
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
          </DocxDisplay>
        )}
      </div>
    </LocaleProvider>
  )
}
