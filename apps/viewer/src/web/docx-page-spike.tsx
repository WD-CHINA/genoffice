import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorContent, useEditor } from '@tiptap/react'
import { parseDocx } from '@genoffice/docx-engine'
import {
  editorExtensions,
  setLazyMediaHashes,
} from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import { setDocFontTable } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import '@genoffice/ui/tokens.css'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'
import './docx-page-spike.css'
import { pageTops, paginateBlocks, visiblePages } from './docx-pagination'

const PAGE_HEIGHT = 900
const PAGE_WIDTH = 760

function estimateHeight(block: any): number {
  if (block.type === 'table') return 320
  if (block.type === 'image') return 240
  if (block.type === 'passthrough') return 24
  const text = (block.runs || []).map((run: any) => run.text || '').join('')
  return Math.max(24, 22 + Math.ceil(text.length / 70) * 20)
}

function PageEditor({ doc, blocks, height }: { doc: any; blocks: any[]; height: number }) {
  const editor = useEditor({
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  useEffect(() => {
    if (!editor) return
    const storage = editor.storage.listNumbering as any
    storage.styles = doc.styles
    storage.docDefaults = doc.docDefaults
    storage.defs = doc.numbering
    editor.commands.setContent(blocksToPmDoc(blocks, undefined, pmDocOptions(doc)), {
      emitUpdate: false,
    })
  }, [editor, doc, blocks])
  return (
    <div className="docx-page-spike-page" style={{ height, width: PAGE_WIDTH }}>
      {editor ? <EditorContent editor={editor} /> : <p>创建 editor…</p>}
    </div>
  )
}

function Spike() {
  const [doc, setDoc] = useState<any>(null)
  const [error, setError] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [heap, setHeap] = useState(0)
  const [nodes, setNodes] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const viewportHeight = viewport.current?.clientHeight || 720

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/docx-spike-large.docx')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const parsed = await parseDocx(bytes)
        setLazyMediaHashes(parsed.extras.lazyMediaHashes)
        setDocFontTable(parsed.fontTable)
        setDoc(parsed)
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [])

  const pages = useMemo(() => {
    if (!doc) return []
    const measures = doc.blocks.map((block: any) => ({
      height: estimateHeight(block),
      breakBefore: block.type === 'heading',
    }))
    return paginateBlocks(measures, PAGE_HEIGHT)
  }, [doc])
  const tops = useMemo(() => pageTops(pages), [pages])
  const totalHeight = tops.length ? tops[tops.length - 1] + pages[pages.length - 1].height : 0
  const range = visiblePages(
    tops,
    pages.map((page) => page.height),
    scrollTop,
    viewportHeight,
    2,
  )

  useEffect(() => {
    const timer = setInterval(() => {
      setHeap((performance as any).memory?.usedJSHeapSize || 0)
      setNodes(document.querySelectorAll('*').length)
    }, 500)
    return () => clearInterval(timer)
  }, [])

  const jump = (index: number) => {
    const element = viewport.current
    if (!element) return
    element.scrollTop = tops[index] || 0
    setScrollTop(element.scrollTop)
  }

  return (
    <main className="docx-page-spike">
      <header>
        <a href="/">Office Viewer</a>
        <h1>DOCX 按页 Tiptap Spike</h1>
        <p>
          真实 DOCX 解析后按估算高度分页，每页一个只读 Tiptap editor，只挂载可见页 ±2。 这是 Gate B
          的内存/行为实验，不是生产分页。
        </p>
      </header>
      {error && <p className="docx-page-spike-error">{error}</p>}
      {doc && (
        <>
          <section className="docx-page-spike-stats">
            <span>blocks: {doc.blocks.length}</span>
            <span>pages: {pages.length}</span>
            <span>
              mounted: {range.start + 1}–{range.end} ({range.end - range.start})
            </span>
            <span>DOM nodes: {nodes}</span>
            <span>JS heap: {(heap / 1024 ** 2).toFixed(1)} MiB</span>
            <span>scrollTop: {Math.round(scrollTop)}</span>
          </section>
          <div className="docx-page-spike-controls">
            <button onClick={() => jump(0)}>第一页</button>
            <button onClick={() => jump(Math.floor(pages.length / 2))}>中间页</button>
            <button onClick={() => jump(pages.length - 1)}>最后一页</button>
          </div>
          <div
            className="docx-page-spike-viewport"
            ref={viewport}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div className="docx-page-spike-canvas" style={{ height: totalHeight }}>
              {pages.slice(range.start, range.end).map((page) => (
                <div
                  key={page.index}
                  className="docx-page-spike-slot"
                  style={{ transform: `translateY(${tops[page.index]}px)` }}
                >
                  <PageEditor
                    doc={doc}
                    blocks={doc.blocks.slice(page.blockStart, page.blockEnd)}
                    height={page.height}
                  />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      {!doc && !error && <p>正在解析 docx…</p>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Spike />)
