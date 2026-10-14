import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { api, post } from './api'
import { ToolbarIcon } from './toolbar-icon'
import { applyViewerUi, readViewerUi, viewerUiParams } from './ui-options'
import '@genoffice/ui/tokens.css'
import './viewer.css'

type Source = { kind: 'file'; file: File } | { kind: 'url'; url: string }
const linkParams = new URLSearchParams(location.search)
const ui = readViewerUi(linkParams)
const initialUrl = linkParams.get('url')?.trim() || ''
applyViewerUi(ui)

function Host() {
  const [session, setSession] = useState<any>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false)
  const [heartbeatMs, setHeartbeatMs] = useState(60_000)
  const [connectionError, setConnectionError] = useState('')
  const [expired, setExpired] = useState(false)
  const [importUrl, setImportUrl] = useState(initialUrl)
  const lastSource = useRef<Source | null>(null)
  const opening = useRef(false)
  const current = useRef<string | null>(null)
  useEffect(() => {
    void api('health')
      .then((data) => {
        setHeartbeatMs(data.heartbeatMs || 60_000)
        setReady(true)
      })
      .catch((e) => setError(e.message))
    return () => {
      if (current.current) void api(`view-sessions/${current.current}`, { method: 'DELETE' })
    }
  }, [])
  useEffect(() => {
    if (ready && initialUrl) void open({ kind: 'url', url: initialUrl })
  }, [ready])
  useEffect(() => {
    if (!session) return
    let cancelled = false,
      running = false
    const renew = async () => {
      if (running || cancelled) return
      running = true
      try {
        const response = await fetch(`/api/view-sessions/${session.id}`)
        if (cancelled) return
        if (response.status === 404 || response.status === 401) {
          setExpired(true)
          setConnectionError('预览会话已失效，请重新打开文件。')
          cancelled = true
        } else if (!response.ok) throw new Error('Connection unavailable')
        else setConnectionError('')
      } catch {
        if (!cancelled) setConnectionError('连接暂时中断，正在尝试恢复…')
      } finally {
        running = false
      }
    }
    const timer = setInterval(() => void renew(), heartbeatMs)
    const resume = () => {
      if (document.visibilityState === 'visible') void renew()
    }
    document.addEventListener('visibilitychange', resume)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [session, heartbeatMs])
  async function open(source?: Source) {
    if (!source || opening.current) return
    opening.current = true
    lastSource.current = source
    setExpired(false)
    setConnectionError('')
    setBusy(true)
    setError('')
    setSession(null)
    try {
      if (current.current) {
        await api(`view-sessions/${current.current}`, { method: 'DELETE' }).catch(() => {})
        current.current = null
      }
      const record =
        source.kind === 'url'
          ? await post('files/import-url', { url: source.url })
          : await api('files', {
              method: 'POST',
              headers: {
                'X-File-Name': encodeURIComponent(source.file.name),
                'Content-Type': 'application/octet-stream',
              },
              body: source.file,
            })
      const next = await post('view-sessions', { fileId: record.id, width: 960 })
      current.current = next.id
      setSession(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      opening.current = false
      setBusy(false)
    }
  }
  return (
    <main className="viewer-host">
      <header className="viewer-bar viewer-file-bar" hidden={!ui.showHeader}>
        <strong className="viewer-brand">
          <span className="viewer-brand-icon">
            <ToolbarIcon name="document" />
          </span>
          Office Viewer
        </strong>
        <span className="viewer-file-name" title={session?.name || undefined}>
          {session?.name || 'PPT · PDF · Word'}
        </span>
        <label className="viewer-button" hidden={!ui.showImport}>
          <ToolbarIcon name="folder" />
          打开文件
          <input
            aria-label="打开文件"
            type="file"
            accept=".pptx,.pdf,.docx"
            disabled={!ready || busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void open({ kind: 'file', file })
              e.target.value = ''
            }}
          />
        </label>
        <form
          className="viewer-url-import"
          hidden={!ui.showUrlImport}
          onSubmit={(event) => {
            event.preventDefault()
            if (ready && importUrl.trim()) void open({ kind: 'url', url: importUrl.trim() })
          }}
        >
          <input
            aria-label="文件 URL"
            type="url"
            required
            placeholder="粘贴 PPT、Word 或 PDF 文件链接"
            value={importUrl}
            disabled={!ready || busy}
            onChange={(event) => setImportUrl(event.target.value)}
          />
          <button type="submit" disabled={!ready || busy || !importUrl.trim()}>
            <ToolbarIcon name="link" />
            导入 URL
          </button>
        </form>
      </header>
      {error && (
        <p role="alert" className="viewer-error">
          {error}
        </p>
      )}
      {connectionError && (
        <p role="alert" className="viewer-error">
          {connectionError}
          {expired && (
            <button onClick={() => void open(lastSource.current || undefined)}>重新打开</button>
          )}
        </p>
      )}
      {busy ? (
        <div className="viewer-empty">
          {lastSource.current?.kind === 'url' ? '正在下载并打开…' : '正在打开…'}
        </div>
      ) : session && !expired ? (
        <iframe
          key={session.id}
          title={session.name}
          src={`/preview.html?${new URLSearchParams({ session: session.id, format: session.format, ...viewerUiParams(ui) })}`}
          allow="fullscreen"
        />
      ) : (
        <div className="viewer-empty">
          <h1>打开文档，开始预览</h1>
          <p>支持 .pptx、.pdf、.docx，保留项目原有渲染方式。</p>
          <p>支持预览和 PPT 放映。</p>
          <p>可选择本地文件，或粘贴可直接下载的 HTTP/HTTPS 文件链接。</p>
        </div>
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Host />)
