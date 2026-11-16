import React, { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  PAGE_MARK,
  TOTAL_PAGES_MARK,
  type DocxReadingContext,
  type NoteInfo,
} from '@genoffice/docx-engine'
import { HeaderFooterArea } from '@genoffice/viewer-renderers/docs/renderer/components/HeaderFooterArea'
import { appendNoteRuns } from '@genoffice/viewer-renderers/docs/renderer/viewer-layout'
import {
  cssFontFamily,
  resolveNoteStyle,
  noteRunStyle,
} from '@genoffice/viewer-renderers/docs/renderer/line-metrics'
import { ViewerBar } from './viewer-bar'
import { ControlButton, ToolbarMore, ZoomControl, contentArea } from './viewer-controls'
import { hfPartId } from './docx-section-layout'

/** Continuous reading starts at actual size, like apps/docs Read Mode. */
export function useDocxReadingZoom(viewport: RefObject<HTMLDivElement | null>, width: number) {
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(false)
  useEffect(() => {
    const element = viewport.current
    if (!fitWidth || !element || !width) return
    const update = () => setZoom(Math.max(0.25, Math.min(3, contentArea(element).width / width)))
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [fitWidth, width, viewport])
  const changeZoom = (direction: number) => {
    setFitWidth(false)
    setZoom((value) => Math.max(0.25, Math.min(3, value + direction * 0.1)))
  }
  return {
    zoom,
    fitWidth,
    changeZoom,
    fit: () => setFitWidth(true),
    actualSize: () => {
      setFitWidth(false)
      setZoom(1)
    },
  }
}

export function DocxReadingBar({
  controls,
  children,
}: {
  controls: ReturnType<typeof useDocxReadingZoom>
  children?: React.ReactNode
}) {
  return (
    <ViewerBar floating label="Word 控制栏">
      <ZoomControl value={controls.zoom} onZoom={controls.changeZoom} />
      <ToolbarMore zoom={{ value: controls.zoom, onZoom: controls.changeZoom }}>
        <ControlButton
          icon="width"
          label="适合宽度"
          aria-pressed={controls.fitWidth}
          onClick={controls.fit}
        >
          适合宽度
        </ControlButton>
        <button type="button" onClick={controls.actualSize}>
          实际大小
        </button>
        {children}
      </ToolbarMore>
    </ViewerBar>
  )
}

/** Header/footer appear once at the edges of the continuous document. */
export function DocxReadingHf({
  context,
  kind,
}: {
  context: DocxReadingContext
  kind: 'header' | 'footer'
}) {
  const index = kind === 'header' ? 0 : context.sections.length - 1
  const section = context.sections[index]
  if (!section) return null
  const variant = kind === 'header' && section.titlePg ? 'first' : 'default'
  const id = hfPartId(context.sections, index, kind, variant)
  const part = id ? context.hfParts[id] : undefined
  if (!part) return null
  // Pure page counters have no meaning in a continuous reading surface.
  const label = part.text
    .replaceAll(PAGE_MARK, '')
    .replaceAll(TOTAL_PAGES_MARK, '')
    .replace(/page|of|第|页|共|[\d\s,，/—–-]/gi, '')
  if (part.hasPageNumber && !label && !part.images?.length) return null
  return (
    <HeaderFooterArea
      kind={kind}
      value={{ text: part.text, pageNumber: part.hasPageNumber, paras: part.paras }}
      images={part.images}
      readOnly
      onCommit={() => {}}
      pageNo="—"
      pageTotal="—"
      style={{
        position: 'relative',
        left: 0,
        top: 'auto',
        bottom: 'auto',
        transform: 'none',
        width: '100%',
      }}
    />
  )
}

function ReadingNote({
  note,
  kind,
  no,
  styles,
}: {
  note: NoteInfo
  kind: 'footnote' | 'endnote'
  no: number
  styles: any
}) {
  const root = useRef<HTMLDivElement>(null)
  const style = {
    ...resolveNoteStyle(styles, note.styleId, note.spacing),
    ...noteRunStyle(note.richParas),
  }
  useEffect(() => {
    const element = root.current
    if (!element) return
    element.replaceChildren()
    appendNoteRuns(element, { ...note, no }, kind)
  }, [note, kind, no])
  return (
    <div
      ref={root}
      id={`${kind}-${note.id}`}
      data-note-body={note.id}
      data-note-kind={kind}
      style={{
        whiteSpace: 'pre-wrap',
        fontSize: `${(style.sizeHalfPoints ?? 20) / 2}pt`,
        fontFamily: style.fontFamily ? cssFontFamily(style.fontFamily) : undefined,
      }}
    />
  )
}

export function DocxReadingNotes({
  context,
  styles,
}: {
  context: DocxReadingContext
  styles: any
}) {
  return (
    <>
      {(['footnote', 'endnote'] as const).map((kind) => {
        const notes = kind === 'footnote' ? context.footnotes : context.endnotes
        return notes.length ? (
          <section
            key={kind}
            className="viewer-doc-reading-notes"
            aria-label={kind === 'footnote' ? '脚注' : '尾注'}
          >
            {notes.map((note, index) => (
              <ReadingNote
                key={note.id}
                note={note}
                kind={kind}
                no={context.noteNumbers[`${kind}:${note.id}`] ?? index + 1}
                styles={styles}
              />
            ))}
          </section>
        ) : null
      })}
    </>
  )
}
