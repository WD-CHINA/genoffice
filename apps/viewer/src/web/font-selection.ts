import type { RunStyle } from '@genoffice/pptx-render'

export const fontName = (name: string) =>
  name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_]/g, '')

export interface FontVariant {
  family: string
  bold: boolean
  italic: boolean
}

/** CSS cascade order within one family; embedded families appended last win aliases. */
export function fontVariants<T extends FontVariant>(faces: readonly T[], style: RunStyle): T[] {
  if (!faces.length) return []
  const family = faces[faces.length - 1]!.family
  const members = faces.filter((face) => face.family === family)
  const score = (face: T) =>
    Number(face.italic !== !!style.italic) * 2 + Number(face.bold !== !!style.bold)
  const best = Math.min(...members.map(score))
  return members.filter((face) => score(face) === best)
}

/** Portable script fallbacks; all calls use these same names for demand and layout. */
export function fallbackFamilies(style: RunStyle, text = ''): string[] {
  const serif =
    /serif|ming|mincho|batang|myeong|myung|song|simsun|宋|明|cambria|times|palatino|garamond|bookman/i.test(
      style.fontFamily,
    )
  const names: string[] = []
  if (/cambria|caladea/i.test(style.fontFamily) && /[\u0400-\u052f]/.test(text))
    names.push('Cambria Cyrillic GO')
  if (/math/i.test(style.fontFamily)) names.push('GenOffice Symbols')
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(text))
    names.push(serif ? 'GenOffice Serif KR' : 'GenOffice Sans KR')
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text))
    names.push(serif ? 'Noto Serif CJK SC' : 'Noto Sans CJK SC')
  if (/[\u0600-\u06ff\u0750-\u077f]/.test(text)) {
    if (/calibri|carlito|aptos/i.test(style.fontFamily)) names.push('Calibri Arabic GO')
    if (/arial|tahoma|helvetica/i.test(style.fontFamily)) names.push('Arial Arabic GO')
    names.push('Noto Naskh Arabic')
  }
  if (/[\u0590-\u05ff]/.test(text)) names.push('David GO')
  if (/[\u0e00-\u0e7f]/.test(text)) names.push('GenOffice Sarabun')
  if (/[\u0b80-\u0bff]/.test(text)) names.push('GenOffice Tamil')
  if (/[\u0980-\u09ff]/.test(text)) names.push('GenOffice Bengali')
  if (/[\u2100-\u2bff\uf000-\uf0ff\u{1f000}-\u{1fbff}]/u.test(text)) names.push('GenOffice Symbols')
  if (/courier|consolas|mono/i.test(style.fontFamily)) names.push('Liberation Mono')
  else if (serif) names.push('Liberation Serif')
  names.push('Carlito')
  return [...new Set(names)]
}
