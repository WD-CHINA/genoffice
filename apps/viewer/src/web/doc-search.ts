import { findInText } from '@genoffice/viewer-renderers/ui'

export interface DocMatch {
  ranges: Range[]
  anchors: HTMLElement[]
}
const selector = 'p,h1,h2,h3,h4,h5,h6,.doc-li'

function paintBounds(element: HTMLElement) {
  const sheet = element.closest<HTMLElement>('.pv-page')!
  const box = sheet.getBoundingClientRect()
  let left = box.left,
    right = box.right,
    top = box.top,
    bottom = box.bottom
  for (let el = element.parentElement; el && el !== sheet; el = el.parentElement) {
    const style = getComputedStyle(el),
      rect = el.getBoundingClientRect()
    if (['hidden', 'clip'].includes(style.overflowX)) {
      left = Math.max(left, rect.left)
      right = Math.min(right, rect.right)
    }
    if (['hidden', 'clip'].includes(style.overflowY)) {
      top = Math.max(top, rect.top)
      bottom = Math.min(bottom, rect.bottom)
    }
  }
  return { left, right, top, bottom }
}
function intersects(rect: DOMRect, box: ReturnType<typeof paintBounds>) {
  return (
    rect.bottom > box.top && rect.top < box.bottom && rect.right > box.left && rect.left < box.right
  )
}
export function docPaintRect(element: HTMLElement) {
  if (getComputedStyle(element).visibility === 'hidden') return null
  const bounds = paintBounds(element)
  return [...element.getClientRects()].find((rect) => intersects(rect, bounds)) || null
}

/** Match original logical text offsets, then retain only ranges painted on each sliced page. */
export function findDocMatches(root: HTMLElement, query: string): DocMatch[] {
  const hits = new Map<string, DocMatch>()
  if (!query) return []
  for (const paragraph of root.querySelectorAll<HTMLElement>(
    `.pv-content ${selector.split(',').join(',.pv-content ')}`,
  )) {
    if (paragraph.querySelector(selector)) continue
    const sheet = paragraph.closest<HTMLElement>('.pv-page')
    if (!sheet || getComputedStyle(paragraph).visibility === 'hidden') continue
    const block = paragraph.closest<HTMLElement>('[data-idx]') || paragraph
    const ordinal = [...block.querySelectorAll(selector)].indexOf(paragraph)
    const nodes: Text[] = []
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const probe = document.createRange()
      probe.selectNodeContents(node)
      if (probe.getClientRects().length) nodes.push(node as Text)
    }
    const text = nodes.map((n) => n.data).join('')
    const at = (offset: number): [Text, number] => {
      for (const n of nodes) {
        if (offset <= n.length) return [n, offset]
        offset -= n.length
      }
      return [nodes[nodes.length - 1], nodes[nodes.length - 1].length]
    }
    for (const start of findInText(text, query, { matchCase: false, wholeWord: false })) {
      const range = document.createRange()
      range.setStart(...at(start))
      range.setEnd(...at(start + query.length))
      const box = paintBounds(paragraph)
      if (![...range.getClientRects()].some((r) => intersects(r, box))) continue
      const key = `${block.dataset.idx}:${ordinal}:${start}`
      const hit = hits.get(key) || { ranges: [], anchors: [] }
      hit.ranges.push(range)
      hit.anchors.push(paragraph)
      hits.set(key, hit)
    }
  }
  return [...hits.values()]
}

export function paintDocMatches(matches: DocMatch[], active: number) {
  const css = CSS as typeof CSS & { highlights?: Map<string, unknown> }
  const Highlight = (window as any).Highlight
  if (!css.highlights || !Highlight) return
  css.highlights.set('viewer-doc-search', new Highlight(...matches.flatMap((m) => m.ranges)))
  css.highlights.set('viewer-doc-current', new Highlight(...(matches[active]?.ranges || [])))
}

export function scrollDocMatch(hit: DocMatch | undefined) {
  if (!hit) return
  const range = hit.ranges[0],
    anchor = hit.anchors[0]
  const scroll = anchor.closest<HTMLElement>('.pv-scroll')
  const sheet = anchor.closest<HTMLElement>('.pv-page')
  if (!scroll || !sheet) return
  const paper = paintBounds(anchor)
  const rect = [...range.getClientRects()].find((r) => intersects(r, paper))
  if (rect)
    scroll.scrollTop += rect.top - scroll.getBoundingClientRect().top - scroll.clientHeight / 2
}

/** A snapshot may retain off-page text. Copy only selected glyphs inside its paint window. */
export function copyDocSelection(root: HTMLElement, event: React.ClipboardEvent) {
  const selection = document.getSelection()
  if (
    !selection?.rangeCount ||
    !event.clipboardData ||
    !selection.anchorNode?.parentElement?.closest('.pv-content')
  )
    return
  const selected = selection.getRangeAt(0),
    chunks: string[] = [],
    seen = new Set<string>()
  let previousBlock: Element | null = null
  for (const content of root.querySelectorAll<HTMLElement>('.pv-content')) {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    let node: Node | null
    while ((node = walker.nextNode())) {
      const text = node as Text,
        parent = text.parentElement!
      if (!selected.intersectsNode(text) || getComputedStyle(parent).visibility === 'hidden')
        continue
      const box = paintBounds(parent),
        block = parent.closest('[data-idx]') || parent
      const nodes = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let ordinal = 0
      let candidate: Node | null
      while ((candidate = nodes.nextNode()) && candidate !== text) ordinal++
      const range = document.createRange()
      let value = ''
      for (let i = 0; i < text.length; i++) {
        if (selected.comparePoint(text, i) !== 0 || selected.comparePoint(text, i + 1) !== 0)
          continue
        const key = `${(block as HTMLElement).dataset.idx}:${ordinal}:${i}`
        if (seen.has(key)) continue
        range.setStart(text, i)
        range.setEnd(text, i + 1)
        if (![...range.getClientRects()].some((r) => intersects(r, box))) continue
        value += text.data[i]
        seen.add(key)
      }
      if (!value) continue
      const paragraph = parent.closest('p,h1,h2,h3,h4,h5,h6,li,td') || block
      if (previousBlock && previousBlock !== paragraph) chunks.push('\n')
      chunks.push(value)
      previousBlock = paragraph
    }
  }
  event.preventDefault()
  event.clipboardData.setData('text/plain', chunks.join(''))
}
