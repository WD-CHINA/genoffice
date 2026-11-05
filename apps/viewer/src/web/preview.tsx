import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { applyViewerUi, readViewerUi } from './ui-options'
import '@genoffice/ui/tokens.css'
import './viewer.css'
const Slides = lazy(() => import('./slides').then((m) => ({ default: m.Slides })))
const Pdf = lazy(() => import('./pdf').then((m) => ({ default: m.Pdf })))
const Docs = lazy(() => import('./docs').then((m) => ({ default: m.Docs })))
const DocsRemote = lazy(() => import('./docs-remote').then((m) => ({ default: m.DocsRemote })))
const DocsServer = lazy(() => import('./docs-server').then((m) => ({ default: m.DocsServer })))
const params = new URLSearchParams(location.search),
  src = params.get('src') || '',
  format = params.get('format'),
  server = params.get('server') || '',
  fileId = params.get('fileId') || '',
  token = params.get('token') || '',
  layout = params.get('layout') !== 'server',
  contentUrl = params.get('contentUrl') || ''
const remoteSrc =
  server && fileId
    ? `${server.replace(/\/+$/, '')}/v1/files/${encodeURIComponent(fileId)}/content`
    : ''
// The embedding host can pin the theme (an Android app matching its own chrome)
// instead of relying on the WebView's force-dark / prefers-color-scheme.
const forcedTheme = params.get('theme')
if (forcedTheme === 'dark' || forcedTheme === 'light') {
  document.documentElement.dataset.theme = forcedTheme
}
applyViewerUi(readViewerUi(params))
class Boundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(e: Error) {
    return { error: e.message }
  }
  render() {
    return this.state.error ? (
      <p className="viewer-status" role="alert">
        {this.state.error}
      </p>
    ) : (
      this.props.children
    )
  }
}
createRoot(document.getElementById('root')!).render(
  <Boundary>
    <Suspense fallback={<p className="viewer-status">正在加载预览…</p>}>
      {!src ? (
        <p className="viewer-status" role="alert">
          没有可预览的文件
        </p>
      ) : format === 'pptx' ? (
        <Slides
          src={src}
          server={server || undefined}
          fileId={fileId || undefined}
          token={token || undefined}
          layout={layout}
        />
      ) : format === 'pdf' ? (
        <Pdf src={contentUrl || remoteSrc || src} />
      ) : format === 'docx' && server && fileId ? (
        <DocsServer
          server={server}
          fileId={fileId}
          token={token || undefined}
          name={params.get('name') || undefined}
        />
      ) : (
        <Docs src={src} />
      )}
    </Suspense>
  </Boundary>,
)
