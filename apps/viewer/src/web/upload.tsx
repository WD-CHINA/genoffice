import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@genoffice/ui/tokens.css'
import './upload.css'

interface Uploaded {
  fileId: string
  sha256: string
  size: number
  format: string
  createdAt: string
  name: string
}

const HISTORY_KEY = 'genoffice-upload-history'
const params = new URLSearchParams(location.search)
const token = (params.get('token') || '').trim()

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function viewerUrl(item: Uploaded): string {
  const query = new URLSearchParams({ parse: 'server', fileId: item.fileId, name: item.name })
  if (token) query.set('token', token)
  return `/?${query}`
}

function contentUrl(fileId: string): string {
  return `/v1/files/${encodeURIComponent(fileId)}/content`
}

function loadHistory(): Uploaded[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as unknown
    return Array.isArray(parsed) ? (parsed as Uploaded[]) : []
  } catch {
    return []
  }
}

function saveHistory(items: Uploaded[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 12)))
  } catch {
    /* storage may be unavailable */
  }
}

function UploadPage() {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Uploaded | null>(null)
  const [recent, setRecent] = useState<Uploaded[]>(loadHistory)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!result) return
    setRecent((old) => {
      const next = [result, ...old.filter((item) => item.fileId !== result.fileId)]
      saveHistory(next)
      return next
    })
  }, [result])

  const upload = (file: File) => {
    if (busy) return
    const lower = file.name.toLowerCase()
    if (!lower.endsWith('.pptx') && !lower.endsWith('.pdf')) {
      setError('只支持 .pptx 或 .pdf 文件')
      return
    }
    setBusy(true)
    setError('')
    setResult(null)
    setProgress(0)
    const request = new XMLHttpRequest()
    request.open('POST', '/v1/files')
    if (token) request.setRequestHeader('Authorization', `Bearer ${token}`)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) setProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onerror = () => {
      setBusy(false)
      setError('上传失败：无法连接解析服务')
    }
    request.onload = () => {
      setBusy(false)
      if (request.status !== 201) {
        let detail = `HTTP ${request.status}`
        try {
          const body = JSON.parse(request.responseText) as { message?: string }
          detail = body.message || detail
        } catch {
          /* non-JSON error */
        }
        setError(`上传失败：${detail}`)
        return
      }
      const uploaded = JSON.parse(request.responseText) as Omit<Uploaded, 'name'>
      setResult({ ...uploaded, name: file.name })
    }
    request.send(file)
  }

  const onFiles = (files: FileList | null) => {
    const file = files?.[0]
    if (file) upload(file)
  }

  return (
    <main className="upload-page">
      <header className="upload-header">
        <a className="upload-brand" href="/">
          <span className="upload-brand-dot" />
          Office Viewer
        </a>
        <a className="upload-back" href="/">
          返回预览
        </a>
      </header>
      <section className="upload-card">
        <h1>上传到解析服务</h1>
        <p className="upload-hint">
          文件会流式上传到 parse-server，返回 <code>fileId</code> 后可直接在 Viewer
          里用服务端模式打开。
          {token ? ' 当前已附带 token。' : ''}
        </p>
        <div
          className={`upload-drop${dragging ? ' is-dragging' : ''}${busy ? ' is-busy' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            onFiles(event.dataTransfer.files)
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') input.current?.click()
          }}
        >
          <input
            ref={input}
            className="upload-input"
            type="file"
            accept=".pptx,.pdf"
            onChange={(event) => {
              onFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <strong>{busy ? `正在上传… ${progress}%` : '点击选择，或把文件拖到这里'}</strong>
          <span>支持 PPTX / PDF，单文件上限 2 GiB</span>
          {busy && (
            <div className="upload-progress" aria-hidden="true">
              <div style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>

        {error && (
          <p className="upload-error" role="alert">
            {error}
          </p>
        )}

        {result && (
          <div className="upload-result">
            <div className="upload-result-head">
              <strong>上传成功</strong>
              <span>{result.format.toUpperCase()}</span>
            </div>
            <dl>
              <dt>文件</dt>
              <dd title={result.name}>{result.name}</dd>
              <dt>大小</dt>
              <dd>{formatBytes(result.size)}</dd>
              <dt>fileId</dt>
              <dd className="upload-mono">{result.fileId}</dd>
              <dt>内容地址</dt>
              <dd className="upload-mono upload-ellipsis">{contentUrl(result.fileId)}</dd>
            </dl>
            <div className="upload-actions">
              <a
                className="upload-primary"
                href={viewerUrl(result)}
                target="_blank"
                rel="noreferrer"
              >
                在 Viewer 打开
              </a>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(result.fileId)}
              >
                复制 fileId
              </button>
              <button
                type="button"
                onClick={() =>
                  void navigator.clipboard?.writeText(`${location.origin}${viewerUrl(result)}`)
                }
              >
                复制 Viewer 链接
              </button>
            </div>
          </div>
        )}
      </section>

      {recent.length > 0 && (
        <section className="upload-recent">
          <div className="upload-recent-head">
            <h2>最近上传</h2>
            <button
              type="button"
              onClick={() => {
                setRecent([])
                saveHistory([])
              }}
            >
              清空
            </button>
          </div>
          <ul>
            {recent.map((item) => (
              <li key={item.fileId}>
                <div>
                  <strong title={item.name}>{item.name}</strong>
                  <span>
                    {item.format.toUpperCase()} · {formatBytes(item.size)}
                  </span>
                </div>
                <div className="upload-recent-actions">
                  <a href={viewerUrl(item)} target="_blank" rel="noreferrer">
                    打开
                  </a>
                  <button
                    type="button"
                    onClick={() => void navigator.clipboard?.writeText(item.fileId)}
                  >
                    复制 ID
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<UploadPage />)
