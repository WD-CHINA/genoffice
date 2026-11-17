import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import JSZip from 'jszip'
import { previewUrl } from './preview-target'
import { ToolbarIcon } from './toolbar-icon'
import { ViewerBar } from './viewer-bar'
import { applyViewerUi, readViewerUi, viewerUiParams } from './ui-options'
import { fetchCapabilities } from './capabilities'
import { FORMAT_POLICY, decideRoute, precheckLocalFile } from './format-policy'
import { readResponseLimited } from './fetch-limited'
import { pptxHasMedia } from './pptx-media-policy'
import { uploadFile } from './upload-file'
import '@genoffice/ui/tokens.css'
import './viewer.css'

type Format = 'pptx' | 'pdf' | 'docx'
type Source = { kind: 'file'; file: File } | { kind: 'url'; url: string }
type RemoteTarget = { server: string; fileId: string; token?: string }
type ParseMode = 'local' | 'server' | 'auto'
type Opened = { id: string; name: string; format: Format; src: string; remote?: RemoteTarget }
const linkParams = new URLSearchParams(location.search)
const ui = readViewerUi(linkParams)
const retiredPreviewLink = ['fileId', 'url', 'src', 'format', 'contentUrl'].some((key) =>
  linkParams.has(key),
)
// Explicit fidelity fallback; manual server mode otherwise streams the remote model.
const docxLocalFallback = linkParams.get('docxLocalFallback') === '1'
const parseParam = linkParams.get('parse')
const serverUrl = (
  linkParams.get('server') ||
  (parseParam === 'server' || parseParam === 'auto' ? location.origin : '')
)
  .trim()
  .replace(/\/+$/, '')
const serverToken = (linkParams.get('token') || '').trim()
const layoutParam = (linkParams.get('layout') || '').trim()
const PARSE_MODE_KEY = 'genoffice-viewer-parse-mode'
function initialParseMode(): ParseMode {
  const requested = linkParams.get('parse')
  if (requested === 'server' && serverUrl) return 'server'
  if (requested === 'auto' && serverUrl) return 'auto'
  if (requested === 'local') return 'local'
  try {
    const stored = localStorage.getItem(PARSE_MODE_KEY)
    if (stored === 'local') return 'local'
    if (serverUrl && (stored === 'server' || stored === 'auto')) return stored
  } catch {
    /* storage may be unavailable in private mode */
  }
  return serverUrl ? 'auto' : 'local'
}
applyViewerUi(ui)

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
    [parseMode, setParseMode] = useState<ParseMode>(initialParseMode),
    [importUrl, setImportUrl] = useState('')
  const lastSource = useRef<Source | null>(null)
  const opening = useRef(false)
  const currentUrl = useRef<string | null>(null)
  useEffect(() => {
    return () => {
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
    }
  }, [])
  async function open(source?: Source, mode: ParseMode = parseMode) {
    if (!source || opening.current) return
    opening.current = true
    lastSource.current = source
    setBusy(true)
    setError('')
    setOpened(null)
    try {
      // Probe capabilities before reading anything so an impossible local route
      // (large DOCX without a server) fails before the file is buffered.
      const capabilities = serverUrl ? await fetchCapabilities({ baseUrl: serverUrl }) : undefined
      if (source.kind === 'file' && extensionOf(source.file.name))
        precheckLocalFile({
          name: source.file.name,
          size: source.file.size,
          ...(serverUrl ? { serverUrl } : {}),
          ...(capabilities ? { capabilities } : {}),
        })
      let name: string
      let format: Format
      // The iframe only ever needs a URL, so a local file with a known extension is
      // handed over as the File itself — reading it first would hold the whole file
      // in memory twice (the read plus the blob) for no reason.
      let file: Blob
      if (source.kind === 'file' && extensionOf(source.file.name)) {
        if (source.file.size > FORMAT_POLICY.maxFileBytes) throw new Error('文件超过 1 GiB')
        name = source.file.name
        format = extensionOf(source.file.name)!
        file = source.file
      } else if (source.kind === 'file') {
        if (source.file.size > FORMAT_POLICY.maxFileBytes) throw new Error('文件超过 1 GiB')
        const bytes = new Uint8Array(await source.file.arrayBuffer())
        if (!bytes.length) throw new Error('文件是空的')
        if (bytes.length > FORMAT_POLICY.maxFileBytes) throw new Error('文件超过 1 GiB')
        name = source.file.name
        format = await formatOf(name, bytes)
        file = new File([bytes.buffer as ArrayBuffer], name, { type: source.file.type })
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
        if (declared > FORMAT_POLICY.maxFileBytes) throw new Error('文件超过 1 GiB')
        const bytes = await readResponseLimited(response, FORMAT_POLICY.maxFileBytes)
        if (!bytes.length) throw new Error('文件是空的')
        name = nameFrom(source.url, response.headers.get('content-disposition'))
        format = await formatOf(name, bytes)
        file = new Blob([bytes.buffer as ArrayBuffer])
      }
      const route = decideRoute({
        mode,
        ...(serverUrl ? { serverUrl } : {}),
        format,
        size: file.size,
        ...(capabilities ? { capabilities } : {}),
      })
      const resolvedMode: ParseMode =
        route.mode === 'local' &&
        mode === 'auto' &&
        format === 'pptx' &&
        capabilities?.features?.mediaTranscoding === true &&
        (await pptxHasMedia(file))
          ? 'server'
          : route.mode
      let remote: RemoteTarget | undefined
      if (resolvedMode === 'server') {
        if (!serverUrl) throw new Error('没有配置解析服务地址（?server=http://…）')
        const uploaded = await uploadFile(serverUrl, file, format, serverToken)
        remote = { server: serverUrl, fileId: uploaded.fileId, token: serverToken || undefined }
      }
      if (currentUrl.current) URL.revokeObjectURL(currentUrl.current)
      const src = URL.createObjectURL(file)
      currentUrl.current = src
      setOpened({ id: src, name, format, src, remote })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      opening.current = false
      setBusy(false)
    }
  }
  return (
    <main className="viewer-host">
      <ViewerBar className="viewer-file-bar" hidden={!ui.showHeader}>
        <strong className="viewer-brand">
          <span className="viewer-brand-icon">
            <ToolbarIcon name="document" />
          </span>
          Office Viewer
        </strong>
        <span className="viewer-file-name" title={opened?.name || undefined}>
          {opened?.name || 'PPT · PDF · Word'}
        </span>
        <a
          className="viewer-button"
          href={`${import.meta.env.BASE_URL}upload.html?${new URLSearchParams({
            ...(serverUrl ? { server: serverUrl } : {}),
            ...(serverToken ? { token: serverToken } : {}),
          })}`}
          target="_blank"
          rel="noreferrer"
          title="上传文件到解析服务"
        >
          <ToolbarIcon name="link" />
          上传到服务端
        </a>
        <label className="viewer-button viewer-parse-mode" hidden={!serverUrl} title="解析位置">
          解析位置
          <select
            aria-label="解析位置"
            value={parseMode}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as ParseMode
              setParseMode(next)
              try {
                localStorage.setItem(PARSE_MODE_KEY, next)
              } catch {
                /* storage may be unavailable */
              }
              if (lastSource.current) void open(lastSource.current, next)
            }}
          >
            <option value="auto">自动</option>
            <option value="local">本地</option>
            <option value="server">服务端</option>
          </select>
        </label>
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
      </ViewerBar>
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
          src={previewUrl(
            import.meta.env.BASE_URL,
            {
              src: opened.src,
              format: opened.format,
              name: opened.name,
              ...(opened.remote
                ? {
                    ...opened.remote,
                    layout: layoutParam,
                    docxLocalFallback: opened.format === 'docx' && docxLocalFallback,
                  }
                : {}),
              ui: viewerUiParams(ui),
              theme: linkParams.get('theme') || undefined,
            },
            location.origin,
          )}
          allow="fullscreen"
        />
      ) : (
        <div className="viewer-empty">
          <h1>打开文档，开始预览</h1>
          <p>支持 .pptx、.pdf、.docx。默认在浏览器解析，配置解析服务后可切换本地/服务端。</p>
          <p>支持预览和 PPT 放映。</p>
          <p>可选择本地文件，或粘贴允许跨域下载的 HTTP/HTTPS 文件链接。</p>
        </div>
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  retiredPreviewLink ? (
    <p className="viewer-status" role="alert">
      不再支持首页自动预览链接，请使用 preview.html?fileId=… 重新生成链接。{' '}
      <a href={import.meta.env.BASE_URL}>返回首页</a>
    </p>
  ) : (
    <Host />
  ),
)
