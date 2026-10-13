import type {MarkupType} from '../shared/ipc'
export const MARKUP_TYPE_BY_ANNOT: Record<number, MarkupType> = {9:'highlight',10:'underline',12:'strikeout'}
export interface SavedMarkupAnnot {
  pageIndex: number
  /** PDF object number (pdf.js id "123R" → 123) */
  objNum: number
  type: MarkupType
  quads: number[][]
  rect: [number, number, number, number]
}
