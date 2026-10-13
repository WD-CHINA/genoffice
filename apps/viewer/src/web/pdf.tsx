import React, { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import worker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { PdfPage, useVisibleSet } from '@genoffice/viewer-renderers/pdf/renderer/PdfPage'
import { FormLayer } from '@genoffice/viewer-renderers/pdf/renderer/FormLayer'
import { LinkLayer } from '@genoffice/viewer-renderers/pdf/renderer/LinkLayer'
import { buildFormCatalog } from '@genoffice/viewer-renderers/pdf/renderer/form-catalog'
import { DOC_OPTS } from '@genoffice/viewer-renderers/pdf/renderer/view-config'
import '@genoffice/viewer-renderers/pdf/renderer/styles.css'
import '@genoffice/ui/dropdown.css'
GlobalWorkerOptions.workerSrc = worker
export function Pdf({ session }: { session: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null),
    [catalog, setCatalog] = useState<any>(null),
    [geoms, setGeoms] = useState<any[]>([]),
    [scale, setScale] = useState(1),
    [rotation, setRotation] = useState(0),
    [error, setError] = useState(''),
    [query, setQuery] = useState(''),
    [result, setResult] = useState('')
  const scroll = useRef<HTMLDivElement>(null)
  const visible = useVisibleSet(scroll, doc?.numPages || 0, '800px', !!doc)
  useEffect(() => {
    let stopped = false
    const task = getDocument({ url: `/api/view-sessions/${session}/content`, ...DOC_OPTS })
    task.onPassword = (update: (password: string) => void) => {
      const value = window.prompt('请输入 PDF 打开密码')
      if (value !== null) update(value)
      else {
        setError('已取消密码输入')
        void task.destroy()
      }
    }
    void task.promise
      .then(async (document) => {
        const sizes = []
        for (let i = 1; i <= document.numPages; i++) {
          const page = await document.getPage(i)
          const vp = page.getViewport({ scale: 1, rotation: 0 })
          sizes.push({
            pw: vp.width,
            ph: vp.height,
            rot: page.rotate,
            x0: page.view[0],
            y0: page.view[1],
            userUnit: page.userUnit,
          })
        }
        const forms = await buildFormCatalog(document)
        if (!stopped) {
          setGeoms(sizes)
          setCatalog(forms)
          setDoc(document)
        }
      })
      .catch((e) => {
        if (!stopped) setError(e.message)
      })
    return () => {
      stopped = true
      void task.destroy()
    }
  }, [session])
  async function goToDest(dest: any) {
    if (!doc) return
    const value = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!value) return
    const index = typeof value[0] === 'number' ? value[0] : await doc.getPageIndex(value[0])
    scroll.current?.querySelector(`[data-idx="${index}"]`)?.scrollIntoView()
  }
  async function search() {
    if (!doc || !query.trim()) return
    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const text = await (await doc.getPage(i)).getTextContent()
      if (
        text.items
          .map((v: any) => v.str || '')
          .join('')
          .toLowerCase()
          .includes(query.toLowerCase())
      )
        pages.push(i)
    }
    setResult(pages.length ? `匹配页：${pages.join('、')}` : '没有找到匹配内容')
    if (pages.length)
      scroll.current?.querySelector(`[data-idx="${pages[0] - 1}"]`)?.scrollIntoView()
  }
  return (
    <div className="viewer-preview">
      <header className="viewer-bar">
        <button onClick={() => setScale((s) => Math.max(0.25, s - 0.25))}>缩小</button>
        <span>
          {Math.round(scale * 100)}% · {doc?.numPages || 0} 页
        </span>
        <button onClick={() => setScale((s) => Math.min(4, s + 0.25))}>放大</button>
        <button onClick={() => setRotation((r) => (r + 90) % 360)}>旋转</button>
        <input
          aria-label="搜索 PDF"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search()
          }}
        />
        <button onClick={() => void search()}>搜索</button>
      </header>
      {error && <p role="alert">{error}</p>}
      {result && <p>{result}</p>}
      <div ref={scroll} className="viewer-pdf-scroll">
        {doc &&
          geoms.map((geom, i) => {
            const rot = (geom.rot + rotation) % 360,
              odd = rot % 180 !== 0,
              g = { ...geom, rot }
            return (
              <div
                data-idx={i}
                key={i}
                ref={visible.setItemRef(i)}
                className="viewer-pdf-page"
                style={{
                  width: (odd ? geom.ph : geom.pw) * scale,
                  height: (odd ? geom.pw : geom.ph) * scale,
                }}
              >
                <PdfPage
                  doc={doc}
                  pageNo={i + 1}
                  scale={scale}
                  rotationDelta={rotation}
                  visible={visible.visible.has(i)}
                  onRenderState={() => {}}
                />
                {visible.visible.has(i) && (
                  <>
                    <FormLayer
                      widgets={catalog?.byPage.get(i) || []}
                      geom={g}
                      scale={scale}
                      readOnly
                      edits={new Map()}
                      onEdit={() => {}}
                    />
                    <LinkLayer
                      doc={doc}
                      pageNo={i + 1}
                      geom={g}
                      scale={scale}
                      onGoToDest={(dest) => void goToDest(dest)}
                    />
                  </>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}
