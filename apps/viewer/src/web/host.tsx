import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import JSZip from 'jszip'
import { ToolbarIcon } from './toolbar-icon'
import { applyViewerUi, readViewerUi, viewerUiParams } from './ui-options'
import '@genoffice/ui/tokens.css'
import './viewer.css'

type Format = 'pptx' | 'pdf' | 'docx'
type Source = { kind: 'file'; file: File } | { kind: 'url'; url: string }
type Opened = { id: string; name: string; format: Format; src: string }
const linkParams = new URLSearchParams(location.search)
const ui = readViewerUi(linkParams)
const initialUrl = linkParams.get('url')?.trim() || ''
applyViewerUi(ui)

const MAX_BYTES = 1024 * 1024 * 1024

function extensionOf(name: string): Format | null {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext === 'pptx' || ext === 'pdf' || ext === 'docx' ? ext : null
}

async function formatOf(name: string, bytes: Uint8Array): Promise<Format> {
  const named = extensionOf(name)
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') return 'pdf'
  if (named === 'pdf') return 'pdf'
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zip = await JSZip.loadAsync(bytes)
    const types = await zip.file('[Content_Types].xml')?.async('string')
    if (types?.includes('presentationml.presentation') || named === 'pptx') return 'pptx'
    if (types?.includes('wordprocessingml.document') || named === 'docx') return 'docx'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    (named === 'docx' || named === 'pptx')
  )
    return named
  if (named) return named
  throw new Error('只能打开 .pptx、.pdf 或 .docx 文件')
}

function nameFrom(url: string, header: string | null) {
  const match = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(header || '')
  const named = decodeURIComponent(match?.[1] || match?.[2] || '')
  if (named) return named
  try {
    const path = new URL(url).pathname.split('/').pop() || ''
    return decodeURIComponent(path) || 'document'
  } catch {
    return 'document'
  }
}

function Host() {
  const [opened, setOpened] = useState<Opened | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [importUrl, setImportUrl] = useState(initialUrl)
  const lastSource = useRef<Source | null>(null)
  const opening = useRef(false)
  const currentUrl = useRef<string | null>(null)
  useEffect(() => {
    if (initialUrl) void open({ kind: 'url', url: initialUrl })
    return () => {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    }
  }, [])
  async function open(source?: Source) {
    if (!source || opening.current) return
    opening.current = true
    lastSource.current = source
    setBusy(true)
    setError('')
    setOpened(null)
    try {
      let name: string
      let format: Format
      // The iframe only ever needs a URL, so a local file with a known extension is
      // handed over as the File itself — reading it first would hold the whole file
      // in memory twice (the read plus the blob) for no reason.
      let file: Blob
      if (source.kind === 'file' && extensionOf(source.file.name)) {
        name = source.file.name
        format = extensionOf(source.file.name)!
        file = source.file
      } else if (source.kind === 'file') {
        const bytes = new Uint8Array(await source.file.arrayBuffer())
        if (!bytes.length) throw new Error('文件是空的')
        if (bytes.length > MAX_BYTES) throw new Error('文件超过 1 GiB')
        name = source.file.name
        format = await formatOf(name, bytes)
        file = new File([bytes], name, { type: source.file.type })
      } else {
        let response: Response
        try {
          response = await fetch(source.url)
        } catch {
          throw new Error('无法下载该链接。文件服务器需要允许当前页面跨域访问（CORS）。')
        }
        if (!response.ok) throw new Error('下载失败（HTTP ' + response.status + '）')
        // reject an oversized file before pulling it in, when the server says so
        const declared = Number(response.headers.get('content-length'))
        if (declared > MAX_BYTES) throw new Error('文件超过 1 GiB')
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (!bytes.length) throw new Error('文件是空的')
        if (bytes.length > MAX_BYTES) throw new Error('文件超过 1 GiB')
        name = nameFrom(source.url, response.headers.get('content-disposition'))
        format = await formatOf(name, bytes)
        file = new Blob([bytes])
      }
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
      const src = URL.createObjectURL(file)
      currentUrl.current = src
      setOpened({ id: src, name, format, src })
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
        <span className="viewer-file-name" title={opened?.name || undefined}>
          {opened?.name || 'PPT · PDF · Word'}
        </span>
        <label className="viewer-button" hidden={!ui.showImport}>
          <ToolbarIcon name="folder" />
          打开文件
          <input
            aria-label="打开文件"
            type="file"
            accept=".pptx,.pdf,.docx"
            disabled={busy}
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
            if (importUrl.trim()) void open({ kind: 'url', url: importUrl.trim() })
          }}
        >
          <input
            aria-label="文件 URL"
            type="url"
            required
            placeholder="粘贴 PPT、Word 或 PDF 文件链接"
            value={importUrl}
            disabled={busy}
            onChange={(event) => setImportUrl(event.target.value)}
          />
          <button type="submit" disabled={busy || !importUrl.trim()}>
            <ToolbarIcon name="link" />
            导入 URL
          </button>
        </form>
      </header>
      {error && (
        <p role="alert" className="viewer-error">
          {error}
          {lastSource.current && (
            <button onClick={() => void open(lastSource.current || undefined)}>重新打开</button>
          )}
        </p>
      )}
      {busy ? (
        <div className="viewer-empty">
          {lastSource.current?.kind === 'url' ? '正在下载并打开…' : '正在打开…'}
        </div>
      ) : opened ? (
        <iframe
          key={opened.id}
          title={opened.name}
          src={`/preview.html?${new URLSearchParams({ src: opened.src, format: opened.format, name: opened.name, ...viewerUiParams(ui) })}`}
          allow="fullscreen"
        />
      ) : (
        <div className="viewer-empty">
          <h1>打开文档，开始预览</h1>
          <p>支持 .pptx、.pdf、.docx。解析和绘制都在这台浏览器里完成。</p>
          <p>支持预览和 PPT 放映。</p>
          <p>可选择本地文件，或粘贴允许跨域下载的 HTTP/HTTPS 文件链接。</p>
        </div>
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<Host />)
