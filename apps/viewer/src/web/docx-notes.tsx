import { cssFontFamily } from '@genoffice/viewer-renderers/docs/renderer/text-layout/font-rules'
import React, { useLayoutEffect, useRef } from 'react'
import type { DocxReadingContext } from '@genoffice/docx-engine'
import type { PageNoteItem } from '@genoffice/viewer-renderers/docs/renderer/pagination-types'
import {
  appendNoteRuns,
  measureNoteHeightDom,
} from '@genoffice/viewer-renderers/docs/renderer/viewer-layout'
import { noteLineHeightPx, noteRunStyle, resolveNoteStyle } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import { measureBlockGeometry } from './docx-fragments'

export interface RemoteNote extends PageNoteItem {
  key: string
  kind: 'footnote' | 'endnote'
  cuts: number[]
}
export interface NoteSlice {
  key: string
  from: number
  to: number
}
export const noteKey = (section: number, kind: string, id: string) => `${section}:${kind}:${id}`
export const NOTE_SEPARATOR = 12

export function measureNotes(
  context: DocxReadingContext,
  styles: any,
  required?: ReadonlySet<string>,
): Map<string, RemoteNote> {
  const result = new Map<string, RemoteNote>()
  const host = document.createElement('div')
  host.className = 'viewer-doc-remote'
  host.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none'
  document.body.append(host)
  try {
    for (const [sectionIndex, section] of context.sections.entries()) {
      const settings = section.settings
      const width = (settings.pageWidth - settings.marginLeft - settings.marginRight) / 15
      for (const kind of ['footnote', 'endnote'] as const) {
        for (const [index, source] of (kind === 'footnote'
          ? context.footnotes
          : context.endnotes
        ).entries()) {
          if (required && !required.has(noteKey(sectionIndex, kind, source.id))) continue
          const style = {
            ...resolveNoteStyle(styles, source.styleId, source.spacing),
            ...noteRunStyle(source.richParas),
          }
          const lineHeightPx = noteLineHeightPx(settings.docGrid, style)
          const fontSizePt = style.sizeHalfPoints ? style.sizeHalfPoints / 2 : 10
          const fontFamily = style.fontFamily ? cssFontFamily(style.fontFamily) : undefined
          const no = context.noteNumbers[`${kind}:${source.id}`] ?? index + 1
          const height =
            measureNoteHeightDom(
              { ...source, no },
              kind,
              width,
              lineHeightPx,
              fontSizePt,
              fontFamily,
            ) ?? lineHeightPx
          const key = noteKey(sectionIndex, kind, source.id)
          const note: RemoteNote = {
            ...source,
            no,
            key,
            kind,
            height,
            lineHeightPx,
            fontSizePt,
            fontFamily,
            cuts: [],
          }
          host.style.width = `${width}px`
          const row = document.createElement('div')
          row.style.cssText = `font-size:${fontSizePt}pt;line-height:${lineHeightPx}px;white-space:pre-wrap`
          if (fontFamily) row.style.fontFamily = fontFamily
          appendNoteRuns(row, note, kind)
          const sup = row.querySelector('sup')
          if (sup) {
            sup.style.fontSize = '.65em'
            sup.style.marginRight = '4px'
          }
          host.replaceChildren(row)
          note.height = Math.max(height, row.getBoundingClientRect().height)
          note.cuts = measureBlockGeometry(row, note.height).cuts
          result.set(key, note)
        }
      }
    }
  } finally {
    host.remove()
  }
  return result
}

export function RemoteNoteView({
  note,
  from = 0,
  to = note.height,
}: {
  note: RemoteNote
  from?: number
  to?: number
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!root.current) return
    root.current.replaceChildren()
    appendNoteRuns(root.current, note, note.kind)
    const sup = root.current.querySelector('sup')
    if (sup) {
      sup.style.fontSize = '.65em'
      sup.style.marginRight = '4px'
    }
  }, [note])
  return (
    <div
      data-note-body={note.id}
      data-note-kind={note.kind}
      style={{ position: 'relative', height: to - from, overflow: 'hidden' }}
    >
      <div
        ref={root}
        style={{
          position: 'relative',
          top: -from,
          fontSize: `${note.fontSizePt}pt`,
          lineHeight: `${note.lineHeightPx}px`,
          fontFamily: note.fontFamily,
          whiteSpace: 'pre-wrap',
        }}
      />
    </div>
  )
}
