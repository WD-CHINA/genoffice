import { Editor } from '@tiptap/core'
import { editorExtensions } from '@genoffice/viewer-renderers/docs/renderer/editor/extensions'
import {
  blocksToPmDoc,
  pmDocOptions,
} from '@genoffice/viewer-renderers/docs/renderer/editor/convert'

/**
 * Measure block heights in chunks with a hidden Tiptap editor.
 * Table blocks are handled by docx-table-measure; callers should skip them.
 */
export async function measureBlockHeights(
  doc: any,
  blocks: any[],
  chunkSize = 100,
): Promise<Map<number, number>> {
  const heights = new Map<number, number>()
  if (!blocks.length) return heights
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
  try {
    const storage = editor.storage.listNumbering as any
    storage.styles = doc.styles
    storage.docDefaults = doc.docDefaults
    storage.defs = doc.numbering
    await document.fonts.ready
    for (let offset = 0; offset < blocks.length; offset += chunkSize) {
      const chunk = blocks.slice(offset, offset + chunkSize)
      editor.commands.setContent(blocksToPmDoc(chunk, undefined, pmDocOptions(doc)), {
        emitUpdate: false,
      })
      // A timer avoids background-tab requestAnimationFrame throttling; the
      // getBoundingClientRect below forces layout.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      for (const block of chunk) {
        if (block.docxIndex == null) continue
        const element = editor.view.dom.querySelector<HTMLElement>(
          `[data-idx="${CSS.escape(String(block.docxIndex))}"]`,
        )
        if (element) heights.set(block.docxIndex, element.getBoundingClientRect().height)
      }
    }
  } finally {
    editor.destroy()
    host.remove()
  }
  return heights
}
