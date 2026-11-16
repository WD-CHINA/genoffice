import React, { Suspense, lazy, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { resolvePreview, type ResolvedPreview } from './preview-target'
import { applyViewerUi, readViewerUi } from './ui-options'
import '@genoffice/ui/tokens.css'
import './viewer.css'
const Slides = lazy(() => import('./slides').then((m) => ({ default: m.Slides })))
const Pdf = lazy(() => import('./pdf').then((m) => ({ default: m.Pdf })))
const Docs = lazy(() => import('./docs').then((m) => ({ default: m.Docs })))
const DocsServer = lazy(() => import('./docs-server').then((m) => ({ default: m.DocsServer })))
const params = new URLSearchParams(location.search)
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
function Preview() {
  const [target, setTarget] = useState<ResolvedPreview>()
  const [error, setError] = useState('')
  const [attempt, retry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setTarget(undefined)
    setError('')
    void resolvePreview(params, location.origin, controller.signal).then(
      (resolved) => {
        if (!controller.signal.aborted) setTarget(resolved)
      },
      (failure: Error) => {
        if (!controller.signal.aborted) setError(failure.message)
      },
    )
    return () => controller.abort()
  }, [attempt])
  if (error)
    return (
      <p className="viewer-status" role="alert">
        {error} <button onClick={() => retry(attempt + 1)}>重试</button>
      </p>
    )
  if (!target) return <p className="viewer-status">正在加载预览…</p>
  const { src, format, server, fileId, token, name } = target
  return (
    <Boundary>
      <Suspense fallback={<p className="viewer-status">正在加载预览…</p>}>
        {format === 'pptx' ? (
          <Slides
            src={src}
            server={server}
            fileId={fileId}
            token={token}
            layout={target.layout !== 'server'}
          />
        ) : format === 'pdf' ? (
          <Pdf src={src} />
        ) : server && fileId ? (
          <DocsServer
            server={server}
            fileId={fileId}
            token={token}
            name={name}
            localFallback={target.docxLocalFallback}
          />
        ) : (
          <Docs src={src} />
        )}
      </Suspense>
    </Boundary>
  )
}
createRoot(document.getElementById('root')!).render(<Preview />)
