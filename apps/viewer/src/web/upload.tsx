import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { previewUrl } from './preview-target'
import { createLibraryClient, type SavedResource } from './server-library'
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
const apiBase = (params.get('server') || '').trim().replace(/\/+$/, '')
const library = createLibraryClient(apiBase, token)
const homeUrl = `${import.meta.env.BASE_URL}?${new URLSearchParams({ parse: 'server', ...(apiBase ? { server: apiBase } : {}), ...(token ? { token } : {}) })}`

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function viewerUrl(item: Pick<Uploaded, 'fileId' | 'name'>): string {
  return previewUrl(
    import.meta.env.BASE_URL,
    {
      fileId: item.fileId,
      name: item.name,
      server: apiBase || undefined,
      token: token || undefined,
    },
    location.origin,
  )
}

function contentUrl(fileId: string): string {
  return `${apiBase}/v1/files/${encodeURIComponent(fileId)}/content`
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
  const [saved, setSaved] = useState<SavedResource[]>([])
  const removedSaved = useRef(new Set<string>())
  const [savedCursor, setSavedCursor] = useState<string>()
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLibraryBusy(true)
    void library
      .list(undefined, controller.signal)
      .then((page) => {
        setSaved((old) => [
          ...old,
          ...page.items.filter(
            (entry) =>
              !removedSaved.current.has(entry.id) &&
              !old.some((resource) => resource.id === entry.id),
          ),
        ])
        setSavedCursor(page.next)
      })
      .catch((caught: Error) => {
        if (caught.name !== 'AbortError') setError(`读取历史资源失败：${caught.message}`)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLibraryBusy(false)
      })
    return () => controller.abort()
  }, [])

  const saveResource = async (item: Pick<Uploaded, 'fileId' | 'name'>) => {
    if (savingId) return
    setSavingId(item.fileId)
    setError('')
    try {
      const entry = await library.save(item.fileId, item.name)
      removedSaved.current.delete(entry.id)
      setSaved((old) => [entry, ...old.filter((resource) => resource.id !== entry.id)])
    } catch (caught) {
      setError(`保存历史资源失败：${(caught as Error).message}`)
    } finally {
      setSavingId(null)
    }
  }

  const removeResource = async (entry: SavedResource) => {
    if (savingId) return
    setSavingId(entry.fileId)
    setError('')
    try {
      await library.remove(entry.id)
      removedSaved.current.add(entry.id)
      setSaved((old) => old.filter((resource) => resource.id !== entry.id))
    } catch (caught) {
      setError(`移除历史资源失败：${(caught as Error).message}`)
    } finally {
      setSavingId(null)
    }
  }

  const loadMoreSaved = async () => {
    if (!savedCursor || libraryBusy) return
    setLibraryBusy(true)
    try {
      const page = await library.list(savedCursor)
      setSaved((old) => [
        ...old,
        ...page.items.filter(
          (entry) =>
            !removedSaved.current.has(entry.id) &&
            !old.some((resource) => resource.id === entry.id),
        ),
      ])
      setSavedCursor(page.next)
    } catch (caught) {
      setError(`读取历史资源失败：${(caught as Error).message}`)
    } finally {
      setLibraryBusy(false)
    }
  }

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
    if (!lower.endsWith('.pptx') && !lower.endsWith('.pdf') && !lower.endsWith('.docx')) {
      setError('只支持 .pptx / .pdf / .docx 文件')
      return
    }
    setBusy(true)
    setError('')
    setResult(null)
    setProgress(0)
    const request = new XMLHttpRequest()
    request.open('POST', `${apiBase}/v1/files`)
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
        <a className="upload-brand" href={homeUrl}>
          <span className="upload-brand-dot" />
          Office Viewer
        </a>
        <a className="upload-back" href={homeUrl}>
          返回预览
        </a>
      </header>
      <section className="upload-card">
        <h1>上传到解析服务</h1>
        <p className="upload-hint">
          上传后可直接预览。需要长期保留的文件，请点击“保存到历史资源”。
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
            accept=".pptx,.pdf,.docx"
            onChange={(event) => {
              onFiles(event.target.files)
              event.target.value = ''
            }}
          />
          <strong>{busy ? `正在上传… ${progress}%` : '点击选择，或把文件拖到这里'}</strong>
          <span>支持 PPTX / PDF / DOCX，单文件上限 2 GiB</span>
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
              <button
                type="button"
                disabled={!!savingId || saved.some((entry) => entry.fileId === result.fileId)}
                onClick={() => void saveResource(result)}
              >
                {saved.some((entry) => entry.fileId === result.fileId)
                  ? '已保存到历史资源'
                  : savingId === result.fileId
                    ? '正在保存…'
                    : '保存到历史资源'}
              </button>
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
                  void navigator.clipboard?.writeText(
                    new URL(viewerUrl(result), location.origin).href,
                  )
                }
              >
                复制 Viewer 链接
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="upload-recent" aria-label="历史资源">
        <div className="upload-recent-head">
          <h2>历史资源</h2>
        </div>
        <p className="upload-hint">保存的文件不会自动过期。移除后，文件将按临时文件规则清理。</p>
        {!saved.length && <p>{libraryBusy ? '正在读取…' : '暂无已保存的资源'}</p>}
        <ul>
          {saved.map((entry) => (
            <li key={entry.id}>
              <div>
                <strong title={entry.displayName}>{entry.displayName}</strong>
                <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="upload-recent-actions">
                <a
                  href={viewerUrl({ fileId: entry.fileId, name: entry.displayName })}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开
                </a>
                <button
                  type="button"
                  disabled={!!savingId}
                  onClick={() => void removeResource(entry)}
                >
                  从历史资源移除
                </button>
              </div>
            </li>
          ))}
        </ul>
        {savedCursor && (
          <button type="button" disabled={libraryBusy} onClick={() => void loadMoreSaved()}>
            加载更多历史资源
          </button>
        )}
      </section>

      {recent.length > 0 && (
        <section className="upload-recent">
          <div className="upload-recent-head">
            <h2>最近上传（本机）</h2>
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
