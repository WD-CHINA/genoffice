import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorContent, useEditor } from '@tiptap/react'
import { parseDocx } from '@genoffice/docx-engine'
import {
  editorExtensions,
  setLazyMediaHashes,
} from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import { setDocFontTable } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import { measureTableRows, sliceTableBlock } from './docx-table-measure'
import '@genoffice/ui/tokens.css'
import '@genoffice/viewer-renderers/docs/renderer/styles.css'
import '@genoffice/viewer-renderers/docs/renderer/fonts/fonts.css'
import './docx-table-spike.css'
import { paginateTableRows, type TableRowLayout } from './docx-table-pagination'

const PAGE_HEIGHT = 900
const PAGE_WIDTH = 760

function TablePageEditor({ doc, block }: { doc: any; block: any }) {
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
    editor.commands.setContent(blocksToPmDoc([block], undefined, pmDocOptions(doc)), {
      emitUpdate: false,
    })
  }, [editor, doc, block])
  return (
    <div className="docx-table-spike-page" style={{ width: PAGE_WIDTH }}>
      {editor ? <EditorContent editor={editor} /> : <p>创建 editor…</p>}
    </div>
  )
}

function Spike() {
  const [doc, setDoc] = useState<any>(null)
  const [block, setBlock] = useState<any>(null)
  const [rows, setRows] = useState<TableRowLayout[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/docx-spike-table.docx')
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const parsed = await parseDocx(new Uint8Array(await response.arrayBuffer()))
        setLazyMediaHashes(parsed.extras.lazyMediaHashes)
        setDocFontTable(parsed.fontTable)
        const table = parsed.blocks.find((item: any) => item.type === 'table')
        if (!table) throw new Error('fixture has no table')
        setDoc(parsed)
        setBlock(table)
        setRows(await measureTableRows(parsed, table))
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [])

  const pages = useMemo(() => {
    if (!rows.length || !block) return []
    const headerRows = rows.filter((row) => row.header).length
    return paginateTableRows(rows, PAGE_HEIGHT, { headerRows })
  }, [rows, block])

  return (
    <main className="docx-table-spike">
      <header>
        <a href="/">Office Viewer</a>
        <h1>DOCX 表格行级分页 Spike</h1>
        <p>
          真实表格行高测量 → 行级分页 → 表头重复 → cantSplit。这里只渲染表格，验证 Gate B.4
          的表格分页模型。
        </p>
      </header>
      {error && <p className="docx-table-spike-error">{error}</p>}
      {rows.length > 0 && (
        <section className="docx-table-spike-stats">
          <span>rows: {rows.length}</span>
          <span>headerRows: {rows.filter((row) => row.header).length}</span>
          <span>cantSplit: {rows.filter((row) => row.cantSplit).length}</span>
          <span>pages: {pages.length}</span>
          <span>overflow: {pages.filter((page) => page.overflow).length}</span>
        </section>
      )}
      <div className="docx-table-spike-pages">
        {doc &&
          pages.map((page) => (
            <div key={page.rows.map((row) => `${row.row}:${row.part?.start ?? 0}`).join('|')}>
              <div className="docx-table-spike-label">
                page {pages.indexOf(page) + 1} · rows {page.rows.map((row) => row.row).join(', ')}
                {page.overflow ? ' · overflow' : ''}
              </div>
              <TablePageEditor doc={doc} block={sliceTableBlock(block, page)} />
            </div>
          ))}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Spike />)
