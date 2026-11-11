import { Editor } from '@tiptap/core'
import { waitForDocxImages } from './docx-image-ready'
import { waitForDocxLayout } from './docx-layout-ready'
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
  width = 760,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  const heights = new Map<number, number>()
  if (!blocks.length) return heights
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
    for (let offset = 0; offset < blocks.length; offset += chunkSize) {
      signal?.throwIfAborted()
      const chunk = blocks.slice(offset, offset + chunkSize)
      editor.commands.setContent(blocksToPmDoc(chunk, undefined, pmDocOptions(doc)), {
        emitUpdate: false,
      })
      // A timer avoids background-tab requestAnimationFrame throttling; the
      // getBoundingClientRect below forces layout.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      // Read layout after inserting content, so its CSS font requests have started.
      void editor.view.dom.offsetHeight
      await waitForDocxLayout(document.fonts.ready, signal)
      await waitForDocxImages(editor.view.dom.querySelectorAll('img'), signal)
      const elements = chunk.map((block) => block.docxIndex == null ? null : editor.view.dom.querySelector<HTMLElement>(
        `[data-idx="${CSS.escape(String(block.docxIndex))}"]`,
      ))
      for (const [index, block] of chunk.entries()) {
        if (block.docxIndex == null) continue
        const element = elements[index]
        if (element) {
          const bounds = element.getBoundingClientRect()
          const next = elements[index + 1]?.getBoundingClientRect()
          // Include actual paragraph spacing, which is outside its border box.
          // The probe must use the same column width and CSS scope as the page.
          const margin = Number.parseFloat(getComputedStyle(element).marginBottom) || 0
          heights.set(block.docxIndex, Math.max(bounds.height, next ? next.top - bounds.top : bounds.height + margin))
        }
      }
    }
  } finally {
    editor.destroy()
    host.remove()
  }
  return heights
}
