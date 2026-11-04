import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorContent, useEditor } from '@tiptap/react'
import { Editor } from '@tiptap/core'
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
import { pageTops, paginateBlocks, visiblePages, type BlockMeasure } from './docx-pagination'

const PAGE_HEIGHT = 900
const PAGE_WIDTH = 760
const MEASURE_LIMIT = 500

function estimateHeight(block: any): number {
  if (block.type === 'table') return 320
  if (block.type === 'image') return 240
  if (block.type === 'passthrough') return 24
  const text = (block.runs || []).map((run: any) => run.text || '').join('')
  return Math.max(24, 22 + Math.ceil(text.length / 70) * 20)
}

async function measureBlockHeights(
  doc: any,
  blocks: any[],
  onProgress: (done: number) => void,
): Promise<Map<number, number>> {
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;width:760px;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  const heights = new Map<number, number>()
  try {
    const storage = editor.storage.listNumbering as any
    storage.styles = doc.styles
    storage.docDefaults = doc.docDefaults
    storage.defs = doc.numbering
    await document.fonts.ready
    const chunkSize = 100
    for (let offset = 0; offset < blocks.length; offset += chunkSize) {
      const chunk = blocks.slice(offset, offset + chunkSize)
      editor.commands.setContent(blocksToPmDoc(chunk, undefined, pmDocOptions(doc)), {
        emitUpdate: false,
      })
      // getBoundingClientRect below forces layout; a timer avoids background-tab
      // requestAnimationFrame throttling during automated runs.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      for (const block of chunk) {
        const element = editor.view.dom.querySelector<HTMLElement>(
          `[data-idx="${CSS.escape(String(block.docxIndex))}"]`,
        )
        if (element) heights.set(block.docxIndex, element.getBoundingClientRect().height)
      }
      onProgress(Math.min(blocks.length, offset + chunk.length))
    }
  } finally {
    editor.destroy()
    host.remove()
  }
  return heights
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

async function checkParity(
  doc: any,
  pages: Array<{ blockStart: number; blockEnd: number }>,
): Promise<{ equal: boolean; fullLength: number; pageLength: number }> {
  const host = document.createElement('div')
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;width:760px;visibility:hidden;pointer-events:none'
  document.body.appendChild(host)
  const make = () =>
    new Editor({
      element: host,
      extensions: editorExtensions,
      editable: false,
      editorProps: { attributes: { class: 'doc-page' } },
    })
  try {
    const full = make()
    const storage = full.storage.listNumbering as any
    storage.styles = doc.styles
    storage.docDefaults = doc.docDefaults
    storage.defs = doc.numbering
    full.commands.setContent(blocksToPmDoc(doc.blocks, undefined, pmDocOptions(doc)), {
      emitUpdate: false,
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const fullText = normalizeText(full.getText())
    full.destroy()
    let pageText = ''
    for (const page of pages) {
      const pageEditor = make()
      pageEditor.commands.setContent(
        blocksToPmDoc(
          doc.blocks.slice(page.blockStart, page.blockEnd),
          undefined,
          pmDocOptions(doc),
        ),
        { emitUpdate: false },
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      pageText += normalizeText(pageEditor.getText())
      pageEditor.destroy()
    }
    return {
      equal: fullText === pageText,
      fullLength: fullText.length,
      pageLength: pageText.length,
    }
  } finally {
    host.remove()
  }
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
  const [fixture, setFixture] = useState<'large' | 'behavior'>('large')
  const [mode, setMode] = useState<'estimate' | 'measure'>('estimate')
  const [measured, setMeasured] = useState<Map<number, number> | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measureDone, setMeasureDone] = useState(0)
  const [parity, setParity] = useState<{
    equal: boolean
    fullLength: number
    pageLength: number
  } | null>(null)
  const [jumpMs, setJumpMs] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const viewportHeight = viewport.current?.clientHeight || 720

  useEffect(() => {
    setDoc(null)
    setMeasured(null)
    setParity(null)
    setMode('estimate')
    void (async () => {
      try {
        const response = await fetch(
          fixture === 'behavior' ? '/docx-spike-behavior.docx' : '/docx-spike-large.docx',
        )
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
  }, [fixture])

  const pages = useMemo(() => {
    if (!doc) return []
    const measures: BlockMeasure[] = doc.blocks.map((block: any) => ({
      height: measured?.get(block.docxIndex) ?? estimateHeight(block),
      breakBefore: block.type === 'heading',
    }))
    return paginateBlocks(measures, PAGE_HEIGHT)
  }, [doc, measured])
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

  const measure = async () => {
    if (!doc || measuring) return
    setMeasuring(true)
    setMeasureDone(0)
    try {
      const sample = doc.blocks.slice(0, MEASURE_LIMIT)
      const heights = await measureBlockHeights(doc, sample, setMeasureDone)
      setMeasured(heights)
      setMode('measure')
    } finally {
      setMeasuring(false)
    }
  }

  const jump = (index: number) => {
    const element = viewport.current
    if (!element) return
    const started = performance.now()
    element.scrollTop = tops[index] || 0
    setScrollTop(element.scrollTop)
    setJumpMs(performance.now() - started)
  }

  const runParity = async () => {
    if (!doc) return
    setParity(null)
    setParity(await checkParity(doc, pages))
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
        <label className="docx-page-spike-fixture">
          fixture
          <select
            value={fixture}
            onChange={(event) => setFixture(event.target.value as 'large' | 'behavior')}
          >
            <option value="large">large：50k blocks / 2700 页</option>
            <option value="behavior">behavior：修订 + 脚注 + 长表格</option>
          </select>
        </label>
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
            <span>mode: {mode}</span>
            <span>measured: {measured ? `${measured.size}/${doc.blocks.length}` : '—'}</span>
            <span>jump: {jumpMs.toFixed(1)} ms</span>
            {parity && (
              <span className={parity.equal ? 'is-ok' : 'is-bad'}>
                parity: {parity.equal ? 'ok' : 'diff'} ({parity.fullLength}/{parity.pageLength})
              </span>
            )}
            <span>scrollTop: {Math.round(scrollTop)}</span>
          </section>
          <div className="docx-page-spike-controls">
            <button onClick={() => jump(0)}>第一页</button>
            <button onClick={() => jump(Math.floor(pages.length / 2))}>中间页</button>
            <button onClick={() => jump(pages.length - 1)}>最后一页</button>
            <button onClick={() => setMode('estimate')} disabled={mode === 'estimate'}>
              估算分页
            </button>
            <button onClick={() => void measure()} disabled={measuring}>
              {measuring
                ? `测量中 ${measureDone}/${Math.min(MEASURE_LIMIT, doc.blocks.length)}`
                : `DOM 测量前 ${Math.min(MEASURE_LIMIT, doc.blocks.length)} 块`}
            </button>
            <button onClick={() => void runParity()} disabled={!doc}>
              Parity 检查
            </button>
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
