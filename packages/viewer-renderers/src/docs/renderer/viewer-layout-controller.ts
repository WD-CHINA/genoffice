import type { EditorView } from '@tiptap/pm/view'
import { setColumnLayout } from './editor/column-layout'
import {
  columnLayoutSpecs,
  sectionWidthSpecs,
  sectionTopMarginSpecs,
  sectionGridPitchSpecs,
  sectionCharSpaceSpecs,
  vAlignShiftSpecs,
  mirrorMarginSpecs,
  verticalTextSpecs,
  newWidthPassState,
  widthPassGate,
  pageNumbers,
  paperWidthPx,
  type BlockBox,
  type PageSlice,
  type SectionGeom,
  type ColumnBlockPlacement,
} from './pagination'
import type { SectionInfo } from '@genoffice/docx-engine'

/** Original per-block layout functions, applied before the print snapshot settles. */
export function createViewerLayoutController(
  view: EditorView,
  mixedColumns: boolean,
  mirror: boolean,
  onUnstable?: () => void,
) {
  const widths = newWidthPassState()
  let signature = '',
    passes = 0
  return (
    blocks: BlockBox[],
    slices: PageSlice[],
    sections: SectionInfo[],
    geoms: SectionGeom[],
  ): boolean => {
    const columns = mixedColumns ? columnLayoutSpecs(blocks, slices, sections) : []
    widthPassGate(widths, columns)
    const lists = [
      sectionGridPitchSpecs(blocks, sections),
      sectionCharSpaceSpecs(blocks, sections),
      sectionTopMarginSpecs(blocks, sections),
      sectionWidthSpecs(blocks, sections, geoms, paperWidthPx(sections)),
      ...(mirror && sections[0]
        ? [
            mirrorMarginSpecs(
              blocks,
              slices,
              sections,
              sections[0].settings,
              pageNumbers(slices, sections),
            ),
          ]
        : []),
      columns,
      vAlignShiftSpecs(blocks, slices, sections, geoms),
      verticalTextSpecs(blocks, slices, sections, geoms),
    ]
    const merged = new Map<HTMLElement, ColumnBlockPlacement>()
    for (const spec of lists.flat()) {
      const previous = merged.get(spec.el)
      merged.set(
        spec.el,
        previous
          ? { ...previous, ...spec, dx: previous.dx + spec.dx, dy: previous.dy + spec.dy }
          : spec,
      )
    }
    const specs = [...merged.values()]
    const next = JSON.stringify(specs.map(({ el, ...spec }) => [el.dataset.idx, spec]))
    if (next === signature) return false
    if (passes >= 12) {
      onUnstable?.()
      return false
    }
    signature = next
    passes++
    setColumnLayout(view, specs)
    return true
  }
}

/** Copyable visible pages stay read-only; no editable node islands or inline handlers. */
export function readonlyCloneHtml(html: string): string {
  const host = document.createElement('div')
  host.innerHTML = html
  for (const element of host.querySelectorAll<HTMLElement>('*')) {
    element.removeAttribute('contenteditable')
    if (element.matches('a[href],input,textarea,select,button,[tabindex]')) element.tabIndex = -1
    for (const attribute of [...element.attributes])
      if (attribute.name.startsWith('on')) element.removeAttribute(attribute.name)
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      element.readOnly = true
    if (
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement ||
      (element instanceof HTMLInputElement && ['checkbox', 'radio', 'file'].includes(element.type))
    )
      element.setAttribute('disabled', '')
  }
  for (const element of host.querySelectorAll('script,iframe,object,embed')) element.remove()
  return host.innerHTML
}
