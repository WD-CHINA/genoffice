import React, { useEffect, useState } from 'react'
import { Docs } from './docs'
import { DocxRemoteSession } from './docx-remote-session'
import { DocxFontScope } from './docx-font-scope'
import type { DocxReadingContext, DocxStyleContext } from '@genoffice/docx-engine'
import { setEmbeddedLineMetrics } from '@genoffice/viewer-renderers/docs/renderer/text-layout/font-rules'
import { convertDocxMetafile } from './docx-metafile'
import type { DocxDisplayPosition } from './docx-display-position'
import { openingStateText } from './server-session'

/** Keep original OLE previews; Node passes the media part to the same renderer converter. */
async function materializePreviews(
  value: any,
  headers: Record<string, string>,
  signal: AbortSignal,
  cache: Map<string, Promise<string>>,
) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return
  for (const [key, item] of Object.entries(value)) {
    if (key === 'imageDataUrl' && typeof item === 'string') {
      const ext = /\.(emf|wmf|emz|wmz)(?:[?#]|$)/i.exec(item)?.[1]?.toLowerCase()
      if (ext) {
        if (!cache.has(item))
          cache.set(
            item,
            (async () => {
              const response = await fetch(item, { headers, signal })
              if (!response.ok) throw new Error(`读取嵌入对象预览失败（HTTP ${response.status}）`)
              const converted = await convertDocxMetafile(
                await response.arrayBuffer(),
                `image/${ext}`,
                signal,
              )
              if (!converted) throw new Error('嵌入对象预览转换失败')
              return converted
            })(),
          )
        value[key] = await cache.get(item)
      }
    } else if (key !== 'internal') await materializePreviews(item, headers, signal, cache)
  }
}

/** HTTP supplies the actual parsed model; Electron's layout/draw code owns both display modes. */
export function DocsRemote({
  server,
  fileId,
  token,
  name,
}: {
  server: string
  fileId: string
  token?: string
  name?: string
}) {
  const [position, setPosition] = useState<DocxDisplayPosition>()
  const [model, setModel] = useState<any>()
  const [status, setStatus] = useState('正在创建 DOCX 会话…')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setModel(undefined)
    setError('')
    setStatus('正在创建 DOCX 会话…')
    const fonts = new DocxFontScope(),
      headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    let reading: DocxReadingContext, styles: DocxStyleContext
    const active = new DocxRemoteSession(
      { server, fileId, token, onState: (state) => setStatus(openingStateText(state)) },
      async (opened, signal) => {
        if (!opened.model?.docx) throw new Error('解析服务没有返回 Word 分节与页眉页脚数据')
        reading = opened.model.docx as DocxReadingContext
        await fonts.load(server, opened.sessionId, opened.fonts ?? [], headers, signal)
        setEmbeddedLineMetrics(fonts.lineMetrics())
        const response = await fetch(
          `${server.replace(/\/+$/, '')}/v1/sessions/${opened.sessionId}/styles`,
          { headers, signal },
        )
        if (!response.ok) throw new Error(`读取 DOCX 样式失败（HTTP ${response.status}）`)
        styles = await response.json()
      },
    )
    void (async () => {
      await active.open()
      const blocks: any[] = [],
        anchors: DocxDisplayPosition['blocks'] = [],
        cache = new Map<string, Promise<string>>()
      let cursor: string | undefined
      do {
        const chunk = await active.load(cursor)
        await materializePreviews(chunk.blocks, headers, active.signal, cache)
        for (const unit of chunk.units)
          unit.blocks.forEach((block, blockIndex) =>
            anchors.push({ docxIndex: block.docxIndex, unitId: unit.id, blockIndex }),
          )
        blocks.push(...chunk.blocks)
        cursor = chunk.next
        setStatus(`正在加载正文…（${blocks.length} 块）`)
      } while (cursor)
      active.signal.throwIfAborted()
      const first = reading!.sections[0],
        hf = reading!.hfParts
      const part = (kind: 'header' | 'footer', variant: 'default' | 'first' | 'even') => {
        const id = (kind === 'header' ? first.headerRefs : first.footerRefs)[variant]
        return id ? hf[id] : undefined
      }
      const header = part('header', 'default'),
        footer = part('footer', 'default')
      setModel({
        ...styles!,
        blocks,
        styles: new Map(styles!.styles),
        numbering: new Map(styles!.numbering),
        hfParts: hf,
        headerText: header?.text,
        headerParas: header?.paras,
        headerHasPageNumber: header?.hasPageNumber,
        headerImages: header?.images,
        footerText: footer?.text,
        footerParas: footer?.paras,
        footerHasPageNumber: footer?.hasPageNumber,
        footerImages: footer?.images,
        headerFirst: part('header', 'first'),
        footerFirst: part('footer', 'first'),
        headerEven: part('header', 'even'),
        footerEven: part('footer', 'even'),
        titlePg: first.titlePg,
        evenAndOddHeaders: reading!.evenAndOddHeaders,
        mirrorMargins: reading!.mirrorMargins,
        footnotes: reading!.footnotes,
        endnotes: reading!.endnotes,
        noteNumbers: reading!.noteNumbers,
        footnoteProps: reading!.footnoteProps,
        endnoteProps: reading!.endnoteProps,
        comments: [],
        embeddedFonts: [],
        extras: { lazyMediaHashes: [] },
        internal: { documentXml: '' },
      })
      setPosition({
        fileId,
        blocks: anchors,
        save: (anchor) =>
          active.setLayoutPrefs({
            anchor: {
              unitId: anchor.unitId,
              blockIndex: anchor.blockIndex,
              offsetPx: Math.round(anchor.offset),
            },
          }),
      })
      setStatus('')
    })().catch((cause) => {
      if (!active.signal.aborted) {
        setError(cause.message)
        setStatus('')
      }
    })
    return () => {
      active.close()
      fonts.close()
      setEmbeddedLineMetrics([])
    }
  }, [server, fileId, token, attempt])
  if (error)
    return (
      <div role="alert" className="viewer-error">
        {error} <button onClick={() => setAttempt((v) => v + 1)}>重试</button>
      </div>
    )
  if (!model)
    return (
      <p className="viewer-status" role="status">
        {status}
      </p>
    )
  return <Docs src={`model:${fileId}`} name={name} model={model} position={position} />
}
