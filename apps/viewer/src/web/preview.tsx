import React, { Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { applyViewerUi, readViewerUi } from './ui-options'
import '@genoffice/ui/tokens.css'
import './viewer.css'
const Slides = lazy(() => import('./slides').then((m) => ({ default: m.Slides })))
const Pdf = lazy(() => import('./pdf').then((m) => ({ default: m.Pdf })))
const Docs = lazy(() => import('./docs').then((m) => ({ default: m.Docs })))
const params = new URLSearchParams(location.search),
  session = params.get('session') || '',
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
      {format === 'pptx' ? (
        <Slides session={session} />
      ) : format === 'pdf' ? (
        <Pdf session={session} />
      ) : (
        <Docs session={session} />
      )}
    </Suspense>
  </Boundary>,
)
