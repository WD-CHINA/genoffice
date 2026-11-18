import {
  planByElement,
  planPropsOf,
} from '@genoffice/viewer-renderers/docs/renderer/pagination-plan'
import {
  floatShiftsOf,
  floatCarriesOf,
  setRowFills,
} from '@genoffice/viewer-renderers/docs/renderer/editor/pagination-gaps'
import { BlockIndex } from '@genoffice/viewer-renderers/docs/renderer/pagination-index'
import { applyDocxGridCompat } from './docx-grid-compat'
import type { Editor } from '@tiptap/core'
import type { ParsedDocFull } from '@genoffice/docx-engine'
import { measureBlocks, sectionGeoms } from '@genoffice/viewer-renderers/docs/renderer/pagination'
import {
  prepareFlow,
  sliceFlow,
  type PassContext,
} from '@genoffice/viewer-renderers/docs/renderer/pagination-pass'
import { sectionHfHeights } from '@genoffice/viewer-renderers/docs/renderer/hf-heights'
import { noteSeparatorPx } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import type { HfStripSource } from '@genoffice/viewer-renderers/docs/renderer/hf-heights'
import type { HfVariant } from '@genoffice/viewer-renderers/docs/renderer/pagination-hf'
import type { PageLayout } from '@genoffice/viewer-renderers/docs/renderer/editor/goto'
import type { viewerLayout } from '@genoffice/viewer-renderers/docs/renderer/viewer-layout'

/** Read-only assembly of App.tsx's measureBlocks → prepareFlow → sliceFlow pass. */
export function measureDocxPages(
  editor: Editor,
  parsed: ParsedDocFull,
  layout: ReturnType<typeof viewerLayout>,
  top: number,
  resolveHf: (index: number, kind: 'header' | 'footer', variant: HfVariant) => HfStripSource,
  settle = 0,
): PageLayout {
  const root = editor.view.dom
  const zoom = root.closest<HTMLElement>('.doc-zoom'),
    saved = zoom?.style.zoom
  if (zoom) zoom.style.zoom = '1'
  try {
    applyDocxGridCompat(root)
    const heights = (sections: typeof layout.sections) =>
      sectionHfHeights(sections, resolveHf, {
        titlePg: !!parsed.titlePg,
        evenOddHf: !!parsed.evenAndOddHeaders,
        legacyBands: (parsed.compatibilityMode ?? 0) < 15,
      })
    const hf = heights(layout.sections)
    const geoms = sectionGeoms(layout.sections, hf, !!parsed.evenAndOddHeaders)
    const origin = root.getBoundingClientRect().top + top
    const plan = planByElement(
      editor.state.doc,
      editor.view,
      planPropsOf(parsed, layout.sections, false),
      floatShiftsOf(editor.state),
    )
    const measured = measureBlocks(root, origin, 1, plan, true, floatCarriesOf(editor.state))
    const context: PassContext = {
      sections: layout.sections,
      section: layout.section,
      endnoteItems: layout.endnoteItems,
      endnoteSeparatorPx: noteSeparatorPx('endnote'),
      hfHeightsOf: heights,
      singleHfPx: hf[0],
      singleGeom: geoms[0],
      evenOddHf: !!parsed.evenAndOddHeaders,
      titlePg: !!parsed.titlePg,
      dropCols: layout.colMode === 'none',
      blockMetaOf: layout.blockMetaOf,
      factor: 1,
      out: {
        rowFills: [],
        rowSplits: [],
        floatVShifts: [],
        floatPullUps: [],
        floatCarries: [],
        floatFlows: [],
        floatSplits: [],
        oversizeClips: [],
      },
    }
    const flow = prepareFlow(measured, context),
      { slices, cuts } = sliceFlow(flow, context)
    // App.tsx applies the slicer's row heights to the canvas as well as the
    // preview. Keep the same row geometry in the read-only page layout.
    const index = new BlockIndex(flow.blocks)
    const fills: Array<{ el: Element; targetPx: number; extraPx?: number }> = []
    for (const fill of context.out.rowFills ?? []) {
      const block = flow.blocks[index.firstAtTop(fill.blockTop, (b) => !!b.tableRows)]
      const rows = block?.el
        ? Array.from(block.el.querySelectorAll('tr')).filter(
            (row) =>
              !row.closest('.doc-nested-table') &&
              !row.classList.contains('page-gap') &&
              !row.classList.contains('page-repeat-header'),
          )
        : []
      const el = rows[fill.row]
      if (el) fills.push({ el, targetPx: fill.targetPx, extraPx: fill.extraPx })
    }
    const state = editor.state
    setRowFills(editor.view, fills, undefined, 1)
    if (editor.state !== state && settle < 12)
      return measureDocxPages(editor, parsed, layout, top, resolveHf, settle + 1)
    return {
      passGen: 1,
      blocks: flow.blocks,
      slices,
      cuts,
      sections: flow.secList ?? layout.sections,
      geoms: flow.geoms,
      hfHeights: flow.hfHeights,
      rowSplits: context.out.rowSplits ?? [],
      carries: [],
      floats: flow.floats,
      floatPullUps: context.out.floatPullUps ?? [],
      flow,
      pageNotes: layout.pageFootnotesOf(flow.blocks, slices),
    }
  } finally {
    if (zoom) zoom.style.zoom = saved ?? ''
  }
}
