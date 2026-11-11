import type { DocxReadingContext, SectionInfo, SectionSettings } from '@genoffice/docx-engine'
import { splitClip } from './docx-fragments'
import { NOTE_SEPARATOR, noteKey, type RemoteNote, type NoteSlice } from './docx-notes'
import type { DocxPageBlock } from './docx-page-index'
import type { PageDescriptor } from './docx-pagination'
import { planTableFlow } from './docx-table-flow'

export type HfHeights = ReadonlyMap<string, number>
export interface ColumnRange { blockStart: number; blockEnd: number; height: number; left: number; width: number }
export interface SectionRegion { sectionIndex: number; top: number; columns: ColumnRange[] }
export interface SectionPage extends PageDescriptor {
  sectionIndex: number
  number: number
  settings: SectionSettings
  width: number
  pageHeight: number
  paddingTop: number
  paddingBottom: number
  paddingLeft: number
  paddingRight: number
  headerId?: string
  footerId?: string
  regions: SectionRegion[]
  notes?: NoteSlice[]
  noteHeight?: number
}

const px = (twips: number) => twips / 15
export function sectionIndexAt(sections: readonly SectionInfo[], docxIndex = 0): number {
  let low = 0; let high = sections.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (sections[middle].lastBlockIndex < docxIndex) low = middle + 1
    else high = middle
  }
  return Math.max(0, low)
}
export function hfPartId(sections: readonly SectionInfo[], index: number, kind: 'header' | 'footer', variant: 'default' | 'first' | 'even'): string | undefined {
  for (let section = index; section >= 0; section--) {
    const id = (kind === 'header' ? sections[section].headerRefs : sections[section].footerRefs)[variant]
    if (id) return id
  }
  return undefined
}
export const hfHeightKey = (id: string, width: number) => `${id}:${Math.round(width * 100)}`
export function sectionColumns(settings: SectionSettings): Array<{ left: number; width: number }> {
  const count = Math.max(1, Math.min(64, settings.columns || 1))
  const available = px(settings.pageWidth - settings.marginLeft - settings.marginRight)
  const gap = px(settings.colSpace ?? 720)
  const widths = settings.colWidths?.length === count ? settings.colWidths.map(px)
    : Array(count).fill(Math.max(1, (available - (count - 1) * gap) / count)) as number[]
  let left = 0
  const result = widths.map((width) => { const column = { left, width }; left += width + gap; return column })
  if (settings.bidi) result.reverse()
  return result
}

function geometry(context: DocxReadingContext, sectionIndex: number, number: number, first: boolean, heights: HfHeights) {
  const section = context.sections[sectionIndex]
  const settings = section.settings
  const width = px(settings.pageWidth)
  const textWidth = px(settings.pageWidth - settings.marginLeft - settings.marginRight)
  const variant = section.titlePg && first ? 'first' : context.evenAndOddHeaders && number % 2 === 0 ? 'even' : 'default'
  const headerId = hfPartId(context.sections, sectionIndex, 'header', variant)
  const footerId = hfPartId(context.sections, sectionIndex, 'footer', variant)
  const header = headerId ? heights.get(hfHeightKey(headerId, textWidth)) ?? 0 : 0
  const footer = footerId ? heights.get(hfHeightKey(footerId, textWidth)) ?? 0 : 0
  const swap = context.mirrorMargins && number % 2 === 0
  return {
    settings, width, pageHeight: px(settings.pageHeight), headerId, footerId,
    paddingTop: Math.max(px(settings.marginTop), !settings.marginTopFixed && header ? px(settings.headerDist ?? 720) + header : 0),
    paddingBottom: Math.max(px(settings.marginBottom), !settings.marginBottomFixed && footer ? px(settings.footerDist ?? 720) + footer : 0),
    paddingLeft: px(swap ? settings.marginRight : settings.marginLeft),
    paddingRight: px(swap ? settings.marginLeft : settings.marginRight),
  }
}

/** Minimum page capacity for table splitting; includes every header/footer variant. */
export function sectionContentHeight(context: DocxReadingContext, index: number, heights: HfHeights): number {
  return Math.max(1, Math.min(...[[1, true], [1, false], [2, false]].map(([number, first]) => {
    const box = geometry(context, index, number as number, first as boolean, heights)
    return box.pageHeight - box.paddingTop - box.paddingBottom
  })))
}

/** Word balances the final column set of a section; explicit column breaks stay authoritative. */
function balanceRegion(blocks: readonly DocxPageBlock[], region: SectionRegion): void {
  if (region.columns.length < 2) return
  const occupied = region.columns.filter((column) => column.blockEnd > column.blockStart)
  if (!occupied.length) return
  const start = occupied[0].blockStart
  const end = occupied.at(-1)!.blockEnd
  const values = blocks.slice(start, end)
  if (values.some((block) => block.columnBreakBefore)) return
  const total = values.reduce((sum, block) => sum + block.height, 0)
  let low = values.reduce((largest, block) => Math.max(largest, block.height), total / region.columns.length)
  let high = Math.max(...occupied.map((column) => column.height))
  const pack = (height: number): ColumnRange[] | undefined => {
    const columns = region.columns.map((column) => ({ ...column, blockStart: start, blockEnd: start, height: 0 }))
    let column = 0
    for (let index = start; index < end; index++) {
      const block = blocks[index]
      const next = index + 1 < end ? blocks[index + 1] : undefined
      const keep = block.keepWithNext && next && block.height + next.height <= height &&
        columns[column].height + block.height + next.height > height
      if (columns[column].height > 0 && (columns[column].height + block.height > height + 0.01 || keep)) {
        if (++column === columns.length) return undefined
        columns[column].blockStart = columns[column].blockEnd = index
      }
      columns[column].blockEnd = index + 1
      columns[column].height += block.height
    }
    return columns
  }
  for (let iteration = 0; iteration < 24 && high - low > 0.05; iteration++) {
    const middle = (low + high) / 2
    if (pack(middle)) high = middle
    else low = middle
  }
  const balanced = pack(high)
  if (balanced) region.columns = balanced
}

/** Pagination holds numeric source references only; body models remain in the bounded unit cache. */
export function paginateSectionBlocks(blocks: readonly DocxPageBlock[], context: DocxReadingContext, heights: HfHeights = new Map()): SectionPage[] {
  return layoutSectionBlocks(blocks, context, heights).pages
}

export function layoutSectionBlocks(source: readonly DocxPageBlock[], context: DocxReadingContext,
  heights: HfHeights = new Map(), notes: ReadonlyMap<string, RemoteNote> = new Map()): { blocks: DocxPageBlock[]; pages: SectionPage[] } {
  const blocks = source.map((block) => ({ ...block }))
  if (!blocks.length || !context.sections.length) return { blocks, pages: [] }
  const pages: SectionPage[] = []
  const seen = new Set<number>()
  let current: SectionPage | undefined
  let region: SectionRegion | undefined
  let column = 0
  let previousSection = -1
  let nextNumber = 1
  const pendingNotes: NoteSlice[] = []
  const drainNotes = (sectionIndex: number, start: number) => {
    while (pendingNotes.length) {
      const first = !seen.has(sectionIndex)
      const box = geometry(context, sectionIndex, nextNumber, first, heights)
      const capacity = Math.max(1, box.pageHeight - box.paddingTop - box.paddingBottom - NOTE_SEPARATOR)
      const slices: NoteSlice[] = []
      let used = 0
      while (pendingNotes.length && used < capacity - .5) {
        const item = pendingNotes[0], note = notes.get(item.key)!
        const available = capacity - used
        const end = item.to - item.from <= available ? item.to
          : note.cuts.filter((cut) => cut > item.from && cut <= item.from + available).at(-1)
        if (end === undefined) {
          if (used > 0) break
          // An indivisible authored object is kept visible, never silently discarded.
          slices.push(item); pendingNotes.shift(); used += item.to - item.from; break
        }
        slices.push({ ...item, to: end }); used += end - item.from
        if (end < item.to) pendingNotes[0] = { ...item, from: end }
        else pendingNotes.shift()
      }
      pages.push({ index: pages.length, blockStart: start, blockEnd: start, height: 0, sectionIndex,
        number: nextNumber++, ...box, regions: [], notes: slices, noteHeight: used + NOTE_SEPARATOR })
    }
  }
  const beginPage = (sectionIndex: number, start: number, blank = false) => {
    if (pendingNotes.length && current) drainNotes(current.sectionIndex, start)
    const section = context.sections[sectionIndex]
    const first = !seen.has(sectionIndex)
    if (first && section.pageNumberStart !== undefined) nextNumber = section.pageNumberStart
    const page: SectionPage = { index: pages.length, blockStart: start, blockEnd: start, height: 0,
      sectionIndex, number: nextNumber++, ...geometry(context, sectionIndex, nextNumber - 1, first, heights), regions: [] }
    pages.push(page)
    current = page
    region = undefined
    if (!blank) seen.add(sectionIndex)
    column = 0
    return page
  }
  const beginRegion = (sectionIndex: number, start: number, top: number) => {
    region = { sectionIndex, top, columns: sectionColumns(context.sections[sectionIndex].settings)
      .map((box) => ({ ...box, blockStart: start, blockEnd: start, height: 0 })) }
    current!.regions.push(region)
    column = 0
  }
  for (let index = 0; index < blocks.length; index++) {
    let block = blocks[index]
    const sectionIndex = sectionIndexAt(context.sections, block.docxIndex ?? index)
    const section = context.sections[sectionIndex]
    if (!current) { beginPage(sectionIndex, index); beginRegion(sectionIndex, index, 0) }
    if (previousSection >= 0 && sectionIndex !== previousSection) {
      balanceRegion(blocks, region!)
      current!.height = Math.max(...current!.regions.map((region) => region.top + Math.max(...region.columns.map((column) => column.height))))
      const samePaper = current!.settings.pageWidth === section.settings.pageWidth && current!.settings.pageHeight === section.settings.pageHeight
      const continuous = section.startType === 'continuous' && samePaper
      if (continuous && current!.height < current!.pageHeight - current!.paddingTop - current!.paddingBottom) {
        beginRegion(sectionIndex, index, current!.height)
        seen.add(sectionIndex)
      } else {
        if ((section.startType === 'oddPage' && pages.length % 2 !== 0) ||
          (section.startType === 'evenPage' && pages.length % 2 !== 1)) beginPage(previousSection, index, true)
        beginPage(sectionIndex, index); beginRegion(sectionIndex, index, 0)
      }
    }
    let target = region!.columns[column]
    const pageCapacity = current!.pageHeight - current!.paddingTop - current!.paddingBottom
    if (block.geometry?.tableFlow && !block.geometry.forcedCuts?.length && !block.geometry.notes.length && !block.keepWithNext && !block.clip && !block.tableFlow) {
      const flow = planTableFlow(block.geometry.tableFlow,
        (block.breakBefore || block.columnBreakBefore)
          ? sectionContentHeight(context, sectionIndex, heights)
          : pageCapacity - region!.top - (current!.noteHeight ?? 0) - target.height,
        sectionContentHeight(context, sectionIndex, heights))
      if (flow) {
        blocks.splice(index, 1, ...flow.fragments.map((part, partIndex) => ({ ...block,
          tableFlow: flow, clip: { from: part.from, to: part.to, headerHeight: part.headerHeight },
          height: part.to - part.from + part.headerHeight,
          breakBefore: partIndex === 0 && block.breakBefore,
          columnBreakBefore: partIndex > 0 || flow.startOnNewPage || block.columnBreakBefore,
        })))
        block = blocks[index]
      }
    }
    const clip = block.clip ?? { from: 0, to: block.height }
    const references = (end: number) => (block.geometry?.notes ?? []).filter((ref) => ref.kind === 'footnote'
      && ref.bottom > clip.from + .01 && ref.top < end - .01).map((ref) => noteKey(sectionIndex, ref.kind, ref.id))
    const planNotes = (end: number) => {
      const keys = [...new Set(references(end))].filter((key) => notes.has(key) && !current!.notes?.some((slice) => slice.key === key))
      // Leave room for the referencing line; long notes continue on explicit note pages.
      const twoLines = block.geometry?.cuts.filter((cut) => cut > clip.from + .5)[1] ?? clip.to
      const minimumBody = Math.max(24, Math.min(block.height, twoLines - clip.from))
      let budget = Math.max(0, pageCapacity - (current!.noteHeight ?? 0) - target.height - minimumBody - NOTE_SEPARATOR)
      const slices: NoteSlice[] = [], rest: NoteSlice[] = []
      for (const key of keys) {
        const note = notes.get(key)!
        const end = note.height <= budget ? note.height : note.cuts.filter((cut) => cut <= budget).at(-1) ?? 0
        if (end > 0) { slices.push({ key, from: 0, to: end }); budget -= end }
        if (end < note.height) rest.push({ key, from: end, to: note.height })
      }
      return { slices, rest, height: slices.reduce((sum, slice) => sum + slice.to - slice.from, 0)
        + (slices.length && !current!.notes?.length ? NOTE_SEPARATOR : 0) }
    }
    let notePlan = planNotes(clip.to)
    let capacity = Math.max(1, pageCapacity - region!.top - (current!.noteHeight ?? 0) - notePlan.height)
    const repeated = clip.from > 0 ? block.geometry?.headerHeight ?? 0 : 0
    const available = capacity - target.height - repeated
    let keptHeight = block.height
    if (block.keepWithNext) {
      let position = index
      while (blocks[position]?.keepWithNext && blocks[position + 1] &&
        sectionIndexAt(context.sections, blocks[position + 1].docxIndex ?? position + 1) === sectionIndex) {
        keptHeight += blocks[++position].height
      }
    }
    const moveKeptGroup = block.keepWithNext && target.height > 0 && keptHeight <= capacity && target.height + keptHeight > capacity
    const force = block.geometry?.forcedCuts?.find((cut) => cut > clip.from + .5 && cut < clip.to - .5)
    if (!moveKeptGroup && block.geometry && !block.tableFlow && (block.height > capacity - target.height + .5 || force !== undefined)) {
      const limit = Math.min(clip.to - .5, clip.from + Math.max(0, available), force ?? Infinity)
      let cuts = block.geometry.cuts.filter((cut) => cut > clip.from + .5 && cut <= limit + .01)
      if (block.widowControl !== false && !force) {
        const all = block.geometry.cuts
        cuts = cuts.filter((cut) => all.filter((value) => value > clip.from && value <= cut).length >= 2
          && all.filter((value) => value > cut && value < clip.to).length >= 1)
      }
      const cut = force !== undefined && force <= limit + .01 ? force : cuts.at(-1)
      if (cut !== undefined && (force !== undefined || !block.keepLines || clip.to - clip.from > pageCapacity)) {
        const [head, tail] = splitClip(clip, cut)
        blocks.splice(index, 1, { ...block, clip: head, height: head.to - head.from + repeated, keepWithNext: false },
          { ...block, clip: tail, height: tail.to - tail.from + (block.geometry.headerHeight ?? 0), breakBefore: force === cut,
            columnBreakBefore: false })
        block = blocks[index]
        notePlan = planNotes(cut)
        capacity = Math.max(1, pageCapacity - region!.top - (current!.noteHeight ?? 0) - notePlan.height)
      }
    }
    const next = blocks[index + 1]
    const keep = moveKeptGroup || (block.keepWithNext && next && sectionIndexAt(context.sections, next.docxIndex ?? index + 1) === sectionIndex
      && target.height > 0 && target.height + block.height + next.height > capacity && block.height + next.height <= capacity)
    const noteCollision = current!.regions.some((item) => item.columns.some((box) =>
      item.top + box.height > pageCapacity - (current!.noteHeight ?? 0) - notePlan.height + .5))
    if (noteCollision || (block.breakBefore && current!.blockEnd > current!.blockStart) ||
      block.columnBreakBefore || keep || (region!.top > 0 && block.height > capacity) ||
      (target.height > 0 && target.height + block.height > capacity)) {
      if (!noteCollision && !block.breakBefore && column + 1 < region!.columns.length) {
        column++
        target = region!.columns[column]
        target.blockStart = target.blockEnd = index
      } else {
        beginPage(sectionIndex, index); beginRegion(sectionIndex, index, 0)
        target = region!.columns[0]
      }
      if (block.geometry) {
        block.columnBreakBefore = false
        index--
        continue
      }
      notePlan = planNotes(block.clip?.to ?? clip.to)
    }
    if (notePlan.slices.length) {
      current!.notes = [...(current!.notes ?? []), ...notePlan.slices]
      current!.noteHeight = (current!.noteHeight ?? 0) + notePlan.height
    }
    pendingNotes.push(...notePlan.rest)
    target.blockEnd = index + 1
    target.height += block.height
    current!.blockEnd = index + 1
    current!.height = Math.max(current!.height, region!.top + target.height)
    previousSection = sectionIndex
  }
  if (current && region) {
    balanceRegion(blocks, region)
    current.height = Math.max(...current.regions.map((region) => region.top + Math.max(...region.columns.map((column) => column.height))))
  }
  if (pendingNotes.length && current) drainNotes(current.sectionIndex, blocks.length)
  return { blocks, pages }
}
