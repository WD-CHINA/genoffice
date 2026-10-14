import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { applyViewerUi, readViewerUi } from './ui-options'
import '@genoffice/ui/tokens.css'
import './viewer.css'
const Slides = lazy(() => import('./slides').then((m) => ({ default: m.Slides })))
const Pdf = lazy(() => import('./pdf').then((m) => ({ default: m.Pdf })))
const Docs = lazy(() => import('./docs').then((m) => ({ default: m.Docs })))
const params = new URLSearchParams(location.search),
  src = params.get('src') || '',
  format = params.get('format')
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
        <Slides src={src} />
      ) : format === 'pdf' ? (
        <Pdf src={src} />
      ) : (
        <Docs src={src} />
      )}
    </Suspense>
  </Boundary>,
)
