import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, post } from './api'
import '@genoffice/ui/tokens.css'
import './viewer.css'

function Host() {
  const [session, setSession] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false)
  const current = useRef<string | null>(null)
  useEffect(() => {
    void api('health')
      .then(() => setReady(true))
      .catch((e) => setError(e.message))
    return () => {
      if (current.current) void api(`view-sessions/${current.current}`, { method: 'DELETE' })
    }
  }, [])
  async function open(file?: File) {
    if (!file) return
    setBusy(true)
    setError('')
    setSession(null)
    try {
      if (current.current) {
        await api(`view-sessions/${current.current}`, { method: 'DELETE' })
        current.current = null
      }
      const record = await api('files', {
        method: 'POST',
        headers: {
          'X-File-Name': encodeURIComponent(file.name),
          'Content-Type': 'application/octet-stream',
        },
        body: file,
      })
      const next = await post('view-sessions', { fileId: record.id, width: 960 })
      current.current = next.id
      setSession(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="viewer-host">
      <header className="viewer-bar">
        <strong>GenOffice Viewer</strong>
        <span>{session?.name || 'PPT · PDF · Word'}</span>
        <label className="viewer-button">
          打开文件
          <input
            aria-label="打开文件"
            type="file"
            accept=".pptx,.pdf,.docx"
            disabled={!ready || busy}
            onChange={(e) => {
              void open(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
      </header>
      {error && (
        <p role="alert" className="viewer-error">
          {error}
        </p>
      )}
      {busy ? (
        <div className="viewer-empty">正在打开…</div>
      ) : session ? (
        <iframe
          key={session.id}
          title={session.name}
          src={`/preview.html?session=${session.id}&format=${session.format}`}
          allow="fullscreen"
        />
      ) : (
        <div className="viewer-empty">
          <h1>打开文档，开始预览</h1>
          <p>支持 .pptx、.pdf、.docx，保留项目原有渲染方式。</p>
          <p>支持预览和 PPT 放映。</p>
        </div>
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Host />)
