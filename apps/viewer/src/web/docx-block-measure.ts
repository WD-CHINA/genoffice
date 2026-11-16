import { measureBlockGeometry, type DocxBlockGeometry } from './docx-fragments'
import { Editor } from '@tiptap/core'
import { waitForDocxImages } from './docx-image-ready'
import { waitForDocxLayout } from './docx-layout-ready'
import { docxSectionTypography } from './docx-style-context'
import type { SectionSettings } from '@genoffice/docx-engine'
import { viewerEditorOptions } from '@genoffice/viewer-renderers/docs/renderer/viewer-extensions'
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
  geometries?: Map<number, DocxBlockGeometry>,
  settings?: SectionSettings,
): Promise<Map<number, number>> {
  const heights = new Map<number, number>()
  if (!blocks.length) return heights
  const host = document.createElement('div')
  host.className = 'viewer-doc-remote viewer-doc-reading viewer-doc-remote-measure'
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:auto;display:block;visibility:hidden;pointer-events:none`
  for (const [key, value] of Object.entries(docxSectionTypography(settings))) host.style.setProperty(key, value)
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    ...viewerEditorOptions,
    editorProps: { attributes: { class: 'doc-page', lang: doc.docDefaults?.lang ?? 'en-US' } },
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
          const height = Math.max(bounds.height, next ? next.top - bounds.top : bounds.height + margin)
          heights.set(block.docxIndex, height)
          if (geometries && (block.type === 'paragraph' || block.type === 'listItem'))
            geometries.set(block.docxIndex, measureBlockGeometry(element, height))
        }
      }
    }
  } finally {
    editor.destroy()
    host.remove()
  }
  return heights
}
