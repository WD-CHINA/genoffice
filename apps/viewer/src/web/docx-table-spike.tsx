import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from '@tiptap/core'
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
import './docx-table-spike.css'
import {
  paginateTableRows,
  type TablePage,
  type TablePageRow,
  type TableRowLayout,
} from './docx-table-pagination'

const PAGE_HEIGHT = 900
const PAGE_WIDTH = 760

function measureTableRows(doc: any, block: any): Promise<TableRowLayout[]> {
  return new Promise((resolve) => {
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
    const finish = () => {
      try {
        const storage = editor.storage.listNumbering as any
        storage.styles = doc.styles
        storage.docDefaults = doc.docDefaults
        storage.defs = doc.numbering
        editor.commands.setContent(blocksToPmDoc([block], undefined, pmDocOptions(doc)), {
          emitUpdate: false,
        })
        setTimeout(() => {
          const trs = [...editor.view.dom.querySelectorAll<HTMLTableRowElement>('tr')]
          const table = block.table
          resolve(
            trs.map((tr, index) => ({
              height: tr.getBoundingClientRect().height,
              header: table?.repeatHeaderRows?.[index] === true,
              cantSplit: table?.rowCantSplit?.[index] === true,
              cellParagraphs: [...tr.querySelectorAll('td')].map(
                (td) => td.querySelectorAll('p').length || 1,
              ),
            })),
          )
          editor.destroy()
          host.remove()
        }, 0)
      } catch {
        editor.destroy()
        host.remove()
        resolve([])
      }
    }
    finish()
  })
}

function sliceTableBlock(block: any, page: TablePage): any {
  const table = block.table
  const rows = page.rows.map((entry: TablePageRow) => {
    const source = table.rows[entry.row]
    if (!entry.part) return source
    return source.map((cell: any) => {
      const rich = cell.richParas
        ? cell.richParas.slice(entry.part!.start, entry.part!.end)
        : undefined
      const paras = cell.paras ? cell.paras.slice(entry.part!.start, entry.part!.end) : undefined
      return {
        ...cell,
        ...(rich ? { richParas: rich } : {}),
        ...(paras ? { paras } : {}),
      }
    })
  })
  const rowIndexes = page.rows.map((entry) => entry.row)
  return {
    ...block,
    table: {
      ...table,
      rows,
      repeatHeaderRows: rowIndexes.map((index) => table.repeatHeaderRows?.[index] ?? null),
      rowCantSplit: rowIndexes.map((index) => table.rowCantSplit?.[index] ?? null),
      rawTrPrs: rowIndexes.map((index) => table.rawTrPrs?.[index] ?? null),
      rowRevisions: rowIndexes.map((index) => table.rowRevisions?.[index] ?? null),
    },
  }
}

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
        const response = await fetch('/docx-spike-behavior.docx')
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
