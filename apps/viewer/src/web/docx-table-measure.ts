import { Editor } from '@tiptap/core'
import { waitForDocxImages } from './docx-image-ready'
import { waitForDocxLayout } from './docx-layout-ready'
import { editorExtensions } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'
import type { TablePage, TablePageRow, TableRowLayout } from './docx-table-pagination'

/** Measure top-level table rows (nested tables are excluded by table.rows). */
export async function measureTableRows(
  doc: any, block: any, width = 760, signal?: AbortSignal,
): Promise<TableRowLayout[]> {
  signal?.throwIfAborted()
  const host = document.createElement('div')
  host.className = 'viewer-doc-remote'
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:auto;display:block;visibility:hidden;pointer-events:none`
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: editorExtensions,
    editable: false,
    editorProps: { attributes: { class: 'doc-page' } },
  })
  try {
    const storage = editor.storage.listNumbering as any
    storage.styles = doc.styles
    storage.docDefaults = doc.docDefaults
    storage.defs = doc.numbering
    editor.commands.setContent(blocksToPmDoc([block], undefined, pmDocOptions(doc)), { emitUpdate: false })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    void editor.view.dom.offsetHeight
    await waitForDocxLayout(document.fonts.ready, signal)
    await waitForDocxImages(editor.view.dom.querySelectorAll('img'), signal)
    const table = editor.view.dom.querySelector('table')
    const tableModel = block.table
    return table ? [...table.rows].map((row, index) => ({
      height: row.getBoundingClientRect().height,
      header: tableModel?.repeatHeaderRows?.[index] === true,
      cantSplit: tableModel?.rowCantSplit?.[index] === true,
      cellParagraphs: [...row.cells].map((cell) => cell.querySelectorAll(':scope > p').length || 1),
    })) : []
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('measureTableRows failed', error)
    return []
  } finally {
    editor.destroy()
    host.remove()
  }
}

/**
 * Build the table block for one page. Split rows keep only the paragraph range
 * carried by `part`; merged cells and nested tables are copied as-is.
 */
export function sliceTableBlock(block: any, page: TablePage): any {
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
