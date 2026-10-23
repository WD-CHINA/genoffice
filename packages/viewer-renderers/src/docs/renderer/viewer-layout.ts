import { readSectionSettings, readSections } from '@genoffice/docx-engine'
// Original read-only page-preview calculations from App.tsx, frozen at 48638359.
import { type Block, type NoteInfo, type SectionSettings } from '@genoffice/docx-engine'
import { type NoteKind } from './note-format'
import { imageParaPaginationMeta, paraPaginationMeta, tableWidowOff } from './editor/para-flags'
import {
  tableRowFlags,
  type BlockBox,
  type BlockMeta,
  type PageNoteItem,
  pageAt,
  sectionBidi,
  sectionColGeom,
  sectionColumns,
  type PageSlice,
} from './pagination'
import {
  cssFontFamily,
  estimateFootnoteHeight,
  resolveNoteStyle,
  noteRunStyle,
  noteLineHeightPx,
} from './line-metrics'

function blockNoteScanRuns(b: Block): NonNullable<Block['runs']> {
  const out: NonNullable<Block['runs']> = []
  if (b.runs) out.push(...b.runs)
  const walkTable = (table: NonNullable<Block['table']> | undefined): void => {
    for (const row of table?.rows ?? []) {
      for (const cell of row) {
        for (const p of cell.richParas ?? []) out.push(...p.runs)
        for (const nested of cell.nestedTables ?? []) walkTable(nested)
      }
    }
  }
  if (b.table) walkTable(b.table)
  return out
}
export function viewerLayout(
  parsed: import('@genoffice/docx-engine').ParsedDocFull,
  editor: import('@tiptap/core').Editor,
) {
  const doc = { parsed }
  const section = readSectionSettings(parsed)
  const sections = readSections(parsed)
  const footnotes = parsed.footnotes,
    endnotes = parsed.endnotes
  const editorRef = { current: editor }
  const defaultParaStyle = (() =>
    doc
      ? [...doc.parsed.styles.values()].find((s) => s.type === 'paragraph' && s.isDefault)
      : undefined)()
  const noteStyleOf = (() => {
    const cache = new Map<string, ReturnType<typeof resolveNoteStyle>>()
    return (note?: Pick<NoteInfo, 'styleId' | 'spacing' | 'richParas'>) => {
      const runStyle = noteRunStyle(note?.richParas)
      const key = `${note?.styleId ?? ''}|${JSON.stringify(note?.spacing ?? null)}|${runStyle.fontFamily ?? ''}|${runStyle.sizeHalfPoints ?? ''}`
      let v = cache.get(key)
      if (!v) {
        v = doc
          ? { ...resolveNoteStyle(doc.parsed, note?.styleId, note?.spacing), ...runStyle }
          : {}
        cache.set(key, v)
      }
      return v
    }
  })()
  const noteRenderInfoOf = (() => {
    const cache = new Map<
      string,
      { height: number; lineHeightPx: number; fontSizePt: number; fontFamily?: string }
    >()
    return (
      fn: NoteInfo | undefined,
      no: number,
      sec: SectionSettings,
      kind: NoteKind,
    ): { height: number; lineHeightPx: number; fontSizePt: number; fontFamily?: string } => {
      const contentW = twipsToPx(sec.pageWidth - sec.marginLeft - sec.marginRight)
      const key = `${kind}|${fn?.id ?? ''}|${no}|${Math.round(contentW)}|${fn?.styleId ?? ''}|${fn?.text ?? ''}`
      let v = cache.get(key)
      if (!v) {
        const style = noteStyleOf(fn)
        const lineHeightPx = noteLineHeightPx(sec.docGrid, style)
        const fontSizePt = style.sizeHalfPoints ? style.sizeHalfPoints / 2 : 10
        const fontFamily = style.fontFamily ? cssFontFamily(style.fontFamily) : undefined
        const height =
          measureNoteHeightDom(
            {
              no,
              text: fn?.text ?? '',
              ...(fn?.richParas ? { richParas: fn.richParas } : {}),
              ...(fn?.noRefMark ? { noRefMark: true as const } : {}),
            },
            kind,
            contentW,
            lineHeightPx,
            fontSizePt,
            fontFamily,
          ) ??
          estimateFootnoteHeight(
            fn?.text ?? '',
            contentW,
            sec.docGrid,
            undefined,
            style,
            fn?.richParas,
          )
        v = { height, lineHeightPx, fontSizePt, ...(fontFamily ? { fontFamily } : {}) }
        cache.set(key, v)
      }
      return v
    }
    // note-list deps only reset the cache (keys carry the note text, but
    // formatting-only edits keep it — a fresh map re-measures them)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })()
  const noteMarkNumbers = (() => {
    const out = new Map<string, number>()
    editorRef.current?.state.doc.descendants((node) => {
      if (node.type.name !== 'docNoteRef') return true
      const key = `${node.attrs.kind}:${node.attrs.id}`
      if (!out.has(key)) out.set(key, Number(node.attrs.num))
      return false
    })
    return out
    // the lists change whenever marks are added or removed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })()
  const noteNo = (kind: 'footnote' | 'endnote', id: string, index: number): number =>
    noteMarkNumbers.get(`${kind}:${id}`) ?? doc?.parsed.noteNumbers?.[`${kind}:${id}`] ?? index + 1
  const footnoteBandsOf = (b: Block): Array<{ heightPx: number }> => {
    const runs = blockNoteScanRuns(b)
    if (runs.length === 0 || footnotes.length === 0) return []
    const noOf = new Map(footnotes.map((f, i) => [f.id, noteNo('footnote', f.id, i)]))
    const bands: Array<{ heightPx: number }> = []
    for (const run of runs) {
      if (run.noteRef?.kind !== 'footnote') continue
      const sec = sections.find((s) => (b.docxIndex ?? 0) <= s.lastBlockIndex)?.settings ?? section
      if (!sec) continue
      const fn = footnotes.find((f) => f.id === run.noteRef!.id)
      bands.push({
        heightPx: noteRenderInfoOf(fn, noOf.get(run.noteRef!.id) ?? 0, sec, 'footnote').height,
      })
    }
    // the once-per-page separator is charged by the pagination engine, not per block
    return bands
  }
  const blockByDocxIndex = (() => {
    const m = new Map<number, Block>()
    for (const b of doc?.parsed.blocks ?? [])
      if (b.docxIndex !== null && !m.has(b.docxIndex)) m.set(b.docxIndex, b)
    return m
  })()
  const blockMetaOf = (docxIndex: number): BlockMeta | undefined => {
    const b = blockByDocxIndex.get(docxIndex)
    if (!b) return undefined
    if (b.type === 'table') {
      // notes referenced inside cells reserve their page-bottom area like a
      // paragraph's: the slicer charges them to the rows holding the marks
      const fnBands = footnoteBandsOf(b)
      const fnExtra = fnBands.reduce((s, band) => s + band.heightPx, 0)
      const styleKeepNext = (id: string) => doc?.parsed.styles.get(id)?.display?.keepNext === true
      const xml = b.originalXml ?? ''
      const flagged =
        /tblHeader|cantSplit|keepNext|<w:trHeight\b/.test(xml) ||
        [...xml.matchAll(/<w:pStyle w:val="([^"]+)"/g)].some((m) => styleKeepNext(m[1]))
      const modern = (doc?.parsed.compatibilityMode ?? 0) >= 15
      if (!flagged && fnExtra === 0 && !modern) return undefined
      const cellWidowOff =
        modern &&
        tableWidowOff(
          xml,
          defaultParaStyle?.display?.widowControl ?? doc?.parsed.docDefaults?.widowControl,
          (id) => doc?.parsed.styles.get(id)?.display?.widowControl,
        )
      return {
        ...(flagged ? { tableRowFlags: tableRowFlags(xml, styleKeepNext) } : {}),
        ...(modern ? { modernTableHeaders: true } : {}),
        ...(cellWidowOff ? { cellWidowOff: true } : {}),
        ...(fnExtra > 0 ? { footnoteExtraPx: fnExtra, footnoteBands: fnBands } : {}),
      }
    }
    const styleOf = (id: string | undefined) =>
      (id ? doc?.parsed.styles.get(id) : defaultParaStyle)?.display
    const flags = b.format
      ? paraPaginationMeta(b.format)
      : imageParaPaginationMeta(b.originalXml, styleOf, doc?.parsed.docDefaults)
    const fnBands = footnoteBandsOf(b)
    const fnExtra = fnBands.reduce((s, band) => s + band.heightPx, 0)
    if (!flags && fnExtra === 0) return undefined
    return {
      ...flags,
      ...(fnExtra > 0 ? { footnoteExtraPx: fnExtra, footnoteBands: fnBands } : {}),
    }
  }
  const pageFootnotesOf = (blocks: BlockBox[], slices: PageSlice[]): PageNoteItem[][] => {
    const out: PageNoteItem[][] = slices.map(() => [])
    if (!doc || footnotes.length === 0 || !section) return out
    const noOf = new Map(footnotes.map((f, i) => [f.id, noteNo('footnote', f.id, i)]))
    for (const b of blocks) {
      if (b.docxIndex === undefined) continue
      const pb = blockByDocxIndex.get(b.docxIndex)
      if (!pb) continue
      const ids = blockNoteScanRuns(pb)
        .filter((r) => r.noteRef?.kind === 'footnote')
        .map((r) => r.noteRef!.id)
      if (ids.length === 0) continue
      const blockPage = pageAt(slices, b.top + 0.5) - 1
      const sec = sections.find((s) => b.docxIndex! <= s.lastBlockIndex)?.settings ?? section
      for (let ri = 0; ri < ids.length; ri++) {
        const id = ids[ri]
        const fn = footnotes.find((f) => f.id === id)
        if (!fn) continue
        // notes go to the page holding their reference line (a split
        // paragraph spreads its notes like Word); marker offsets were
        // resolved into noteBands (run order) by applyBlockMeta
        const band = b.noteBands?.length === ids.length ? b.noteBands[ri] : undefined
        const page = band
          ? pageAt(slices, b.top + (b.spaceBeforePx ?? 0) + band.offset + 0.5) - 1
          : blockPage
        const info = noteRenderInfoOf(fn, noOf.get(id) ?? 0, sec, 'footnote')
        out[page]?.push({
          no: noOf.get(id) ?? 0,
          id,
          text: fn.text,
          ...(fn.richParas ? { richParas: fn.richParas } : {}),
          ...(fn.noRefMark ? { noRefMark: true as const } : {}),
          height: info.height,
          lineHeightPx: info.lineHeightPx,
          fontSizePt: info.fontSizePt,
          ...(info.fontFamily ? { fontFamily: info.fontFamily } : {}),
        })
      }
    }
    return out
  }
  const endnoteItems = (() => {
    if (!section || endnotes.length === 0) return []
    const sec = sections[sections.length - 1]?.settings ?? section
    return endnotes.map((n, i) => {
      const no = noteNo('endnote', n.id, i)
      const info = noteRenderInfoOf(n, no, sec, 'endnote')
      return {
        no,
        id: n.id,
        text: n.text,
        ...(n.richParas ? { richParas: n.richParas } : {}),
        ...(n.noRefMark ? { noRefMark: true as const } : {}),
        height: info.height,
        lineHeightPx: info.lineHeightPx,
        fontSizePt: info.fontSizePt,
        ...(info.fontFamily ? { fontFamily: info.fontFamily } : {}),
      }
    })
  })()
  const colMode = (() => {
    if (sections.length === 0) return 'none'
    if (!sections.some((s) => sectionColumns(s) > 1)) return 'none'
    const g0 = sectionColGeom(sections[0])
    const uniform =
      !sections.some(sectionBidi) &&
      // a same-count nextColumn boundary advances a column and a continuous one
      // balances the closed columns mid-page — whole-page CSS multicol can't
      // paint either, so such documents go through mixed mode
      !sections.some(
        (s, i) => i > 0 && (s.startType === 'nextColumn' || s.startType === 'continuous'),
      ) &&
      sections.every((s) => {
        const g = sectionColGeom(s)
        return (
          g.cols === g0.cols &&
          g.cols > 1 &&
          g.equalWidth &&
          Math.abs(g.colWidthPx - g0.colWidthPx) < 0.5 &&
          Math.abs(g.gapPx - g0.gapPx) < 0.5
        )
      })
    return uniform ? 'uniform' : 'mixed'
  })()
  const colFlow = (() => (colMode === 'uniform' ? sectionColGeom(sections[0]) : null))()

  return {
    section,
    sections,
    blockMetaOf,
    pageFootnotesOf,
    endnoteItems,
    colMode: colMode as 'none' | 'uniform' | 'mixed',
    colFlow,
  }
}

const twipsToPx = (twips: number) => (twips / 1440) * 96
import { noteMarkText } from './note-format'
import { textColorValue } from './editor/text-color'
import { setDkColor } from './editor/dark-page'
import { textOutlineCssValue } from './editor/text-outline'
function appendNoteRuns(
  row: HTMLElement,
  it: Omit<PageNoteItem, 'height' | 'id'>,
  kind: NoteKind,
): void {
  if (!it.noRefMark) {
    const sup = document.createElement('sup')
    sup.textContent = noteMarkText(kind, it.no)
    row.append(sup)
  }
  if (it.richParas) {
    it.richParas.forEach((para, pi) => {
      if (pi > 0) row.append(document.createElement('br'))
      for (const run of para) {
        const span = document.createElement('span')
        span.textContent = run.text
        if (run.bold) span.style.fontWeight = '600'
        if (run.italic) span.style.fontStyle = 'italic'
        const deco = [run.underline && 'underline', run.strike && 'line-through'].filter(Boolean)
        if (deco.length > 0) span.style.textDecoration = deco.join(' ')
        if (run.color) {
          span.style.color = textColorValue(run.color)
          // dark-page twin; the authored color stays the declaration
          if (run.color !== 'auto') setDkColor(span, run.color)
        }
        if (run.sizeHalfPoints) span.style.fontSize = `${run.sizeHalfPoints / 2}pt`
        if (run.fontAscii) span.style.fontFamily = cssFontFamily(run.fontAscii)
        if (run.textOutline) span.style.webkitTextStroke = textOutlineCssValue(run.textOutline)
        if (run.caps === 'all') span.style.textTransform = 'uppercase'
        else if (run.caps === 'small') span.style.fontVariantCaps = 'small-caps'
        row.append(span)
      }
    })
  } else {
    const span = document.createElement('span')
    span.textContent = it.text
    row.append(span)
  }
}

/**
 * Hidden DOM measurement of one note entry at the renderers' exact styles: the
 * char-width estimate undercounts complex scripts (prod100r4/022 Arabic notes
 * overprinted each other), so reservation and drawing share the DOM wrap truth.
 */
let noteMeasureHost: HTMLDivElement | null = null
function measureNoteHeightDom(
  entry: Pick<PageNoteItem, 'no' | 'text' | 'richParas' | 'noRefMark'>,
  kind: NoteKind,
  widthPx: number,
  lineHeightPx: number,
  fontSizePt: number,
  fontFamily?: string,
): number | null {
  if (typeof document === 'undefined' || !document.body || widthPx <= 0) return null
  if (!noteMeasureHost || !noteMeasureHost.isConnected) {
    noteMeasureHost = document.createElement('div')
    noteMeasureHost.style.cssText =
      'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;text-align:left;text-indent:0;'
    document.body.appendChild(noteMeasureHost)
  }
  noteMeasureHost.style.fontFamily =
    fontFamily ?? "Calibri, 'DengXian', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif"
  noteMeasureHost.style.width = `${widthPx}px`
  noteMeasureHost.style.fontSize = `${fontSizePt}pt`
  noteMeasureHost.style.lineHeight = `${lineHeightPx}px`
  const row = document.createElement('div')
  appendNoteRuns(row, entry, kind)
  // the renderers' sup style (CSS classes don't reach the detached host)
  const sup = row.querySelector('sup')
  if (sup) {
    sup.style.fontSize = '0.65em'
    sup.style.marginRight = '4px'
  }
  noteMeasureHost.replaceChildren(row)
  const h = row.getBoundingClientRect().height
  noteMeasureHost.replaceChildren()
  return h > 0 ? h : null
}
