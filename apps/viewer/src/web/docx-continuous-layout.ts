import type { DocxPageBlock } from './docx-page-index'
import type { DocxReadingAnchor } from './reading-position'

export interface DocxReadingUnit {
  id: string
  top: number
  height: number
}

/** Virtualize source units without splitting paragraphs/tables or inserting paper gaps. */
export function continuousDocxLayout(blocks: readonly DocxPageBlock[]): {
  units: DocxReadingUnit[]
  height: number
} {
  const units: DocxReadingUnit[] = []
  let height = 0
  for (const block of blocks) {
    let unit = units.at(-1)
    if (!unit || unit.id !== block.unitId) {
      unit = { id: block.unitId, top: height, height: 0 }
      units.push(unit)
    }
    const advance = Math.max(0, block.height)
    unit.height += advance
    height += advance
  }
  return { units, height }
}

export function captureContinuousDocxAnchor(
  blocks: readonly DocxPageBlock[],
  scrollTop: number,
): DocxReadingAnchor | undefined {
  let top = 0
  for (const [index, block] of blocks.entries()) {
    if (top + block.height > scrollTop || index === blocks.length - 1)
      return {
        unitId: block.unitId,
        blockIndex: block.blockIndex,
        offset: Math.max(0, scrollTop - top),
      }
    top += block.height
  }
  return undefined
}

export function restoreContinuousDocxAnchor(
  anchor: DocxReadingAnchor,
  blocks: readonly DocxPageBlock[],
): number | undefined {
  let top = 0
  for (const block of blocks) {
    if (block.unitId === anchor.unitId && block.blockIndex === anchor.blockIndex)
      return Math.max(0, top + Math.min(block.height, anchor.sourceOffset ?? anchor.offset))
    top += block.height
  }
  return undefined
}
