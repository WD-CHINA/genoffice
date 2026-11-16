import type { AnyExtension, EditorOptions } from '@tiptap/core'
import { DocProtected, buildProtectedDom, editorExtensions } from './editor/extensions'
import { drawChartSvg } from './editor/protected-render'
import { readonlyCloneHtml } from './viewer-layout-controller'

// Keep the document schema and layout plugins, without authoring gestures or shortcuts.
const interactionPlugins = new Set([
  'docProtected',
  'docInlineImage',
  'nativeTableSupport',
  'tableHandle',
])

const ViewingProtected = DocProtected.extend({
  draggable: false,
  selectable: false,
  addNodeView() {
    return ({ node }) => {
      const dom = buildProtectedDom(node)
      drawChartSvg(dom, node.attrs.chartDisplay)
      dom.innerHTML = readonlyCloneHtml(dom.innerHTML)
      dom.draggable = false
      return { dom, ignoreMutation: () => true, stopEvent: () => true }
    }
  },
})

const viewerExtensions = editorExtensions.map((extension: AnyExtension) => {
  const base: AnyExtension = extension.name === 'docProtected' ? ViewingProtected : extension
  return base.extend({
    ...(base.type === 'node' ? { draggable: false, selectable: false } : {}),
    addKeyboardShortcuts: () => ({}),
    ...(interactionPlugins.has(base.name) ? { addProseMirrorPlugins: () => [] } : {}),
  })
})

export const viewerEditorOptions: Partial<EditorOptions> = {
  extensions: viewerExtensions,
  editable: false,
  enableCoreExtensions: { keymap: false },
  enableInputRules: false,
  enablePasteRules: false,
}
