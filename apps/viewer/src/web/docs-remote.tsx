import React, { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { editorExtensions } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'

interface Props {
  server: string
  fileId: string
  token?: string
  name?: string
}

interface UnitChunk {
  blocks: any[]
}

export function DocsRemote({ server, fileId, token, name }: Props) {
  const [status, setStatus] = useState('正在创建 DOCX 会话…')
  const [error, setError] = useState('')
  const session = useRef<string | null>(null)
  const editor = useEditor({
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })

  useEffect(() => {
    if (!editor) return
    let cancelled = false
    const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    void (async () => {
      try {
        const created = await fetch(`${server}/v1/sessions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...auth },
          body: JSON.stringify({ fileId }),
        })
        if (!created.ok) throw new Error(`创建 DOCX 会话失败（HTTP ${created.status}）`)
        const opened = (await created.json()) as {
          sessionId: string
          model: { unitCount?: number }
        }
        session.current = opened.sessionId
        const units = await fetch(`${server}/v1/sessions/${opened.sessionId}/units?limit=500`, {
          headers: auth,
        })
        if (!units.ok) throw new Error(`读取 DOCX chunk 列表失败（HTTP ${units.status}）`)
        const listing = (await units.json()) as { items: Array<{ id: string }>; next?: string }
        if (!listing.items.length) throw new Error('DOCX 没有可渲染的 chunk')
        const blocks: any[] = []
        for (const item of listing.items) {
          if (cancelled) return
          setStatus(`正在加载 chunk ${blocks.length}…`)
          const response = await fetch(
            `${server}/v1/sessions/${opened.sessionId}/units/${encodeURIComponent(item.id)}`,
            { headers: auth },
          )
          if (!response.ok) throw new Error(`读取 DOCX chunk 失败（HTTP ${response.status}）`)
          blocks.push(...((await response.json()) as UnitChunk).blocks)
        }
        if (cancelled) return
        editor.commands.setContent(blocksToPmDoc(blocks, undefined, pmDocOptions({})), {
          emitUpdate: false,
        })
        setStatus('')
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
      if (session.current) {
        void fetch(`${server}/v1/sessions/${session.current}`, {
          method: 'DELETE',
          headers: auth,
        }).catch(() => undefined)
      }
    }
  }, [editor, server, fileId, token])

  return (
    <div className="viewer-preview viewer-doc-remote">
      {name && <span className="viewer-doc-remote-name">{name}</span>}
      {status && <p className="viewer-status">{status}</p>}
      {error && (
        <p className="viewer-error" role="alert">
          {error}
        </p>
      )}
      <div className="viewer-doc-canvas">
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
