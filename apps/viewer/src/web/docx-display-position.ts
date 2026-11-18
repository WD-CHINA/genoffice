import { useEffect, useRef } from 'react'
import {
  loadReadingPosition,
  saveDocxReadingAnchor,
  type DocxReadingAnchor,
} from './reading-position'

export interface DocxDisplayPosition {
  fileId: string
  blocks: Array<{ docxIndex: number; unitId: string; blockIndex: number }>
  save(anchor: DocxReadingAnchor): void
}

/** Keep HTTP source anchors across the read-only page layout. */
export function useDocxDisplayPosition(
  root: React.RefObject<HTMLElement | null>,
  position: DocxDisplayPosition | undefined,
  ready: boolean,
  pages: number,
  zoom: number,
  visiblePages: ReadonlySet<number>,
  locate: (index: number) => number | undefined,
) {
  const restoration = useRef<{ position: DocxDisplayPosition; done: boolean } | undefined>(
    undefined,
  )
  useEffect(() => {
    const host = root.current
    if (!host || !position || !ready) return
    const scroll = host.querySelector<HTMLElement>('.pv-scroll')
    if (!scroll) return
    if (restoration.current?.position !== position) restoration.current = { position, done: false }
    const nodes = () =>
      [...scroll.querySelectorAll<HTMLElement>('[data-idx]')].filter((node) => {
        const rect = node.getBoundingClientRect(),
          page = node.closest('.pv-page')?.getBoundingClientRect()
        return rect.height > 0 && (!page || (rect.bottom > page.top && rect.top < page.bottom))
      })
    const saved = loadReadingPosition(position.fileId)?.anchor
    const block =
      saved &&
      position.blocks.find(
        (block) => block.unitId === saved.unitId && block.blockIndex === saved.blockIndex,
      )
    const target = block && nodes().find((node) => Number(node.dataset.idx) === block.docxIndex)
    if (!restoration.current.done && saved && block && !target) {
      const page = locate(block.docxIndex)
      const sheet =
        page === undefined
          ? undefined
          : scroll.querySelector<HTMLElement>(`[data-pv-page="${page}"]`)
      if (sheet)
        scroll.scrollTop += sheet.getBoundingClientRect().top - scroll.getBoundingClientRect().top
      return
    }
    if (!restoration.current.done && saved && target)
      scroll.scrollTop +=
        target.getBoundingClientRect().top -
        scroll.getBoundingClientRect().top +
        saved.offset * zoom
    // Viewport page mounts change while the user scrolls. Only the initial open
    // restores the saved anchor; replaying it on every mount snaps scrolling back.
    restoration.current.done = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const persist = () => {
      const top = scroll.getBoundingClientRect().top
      const node = nodes().find((node) => node.getBoundingClientRect().bottom > top)
      const block =
        node && position.blocks.find((block) => block.docxIndex === Number(node.dataset.idx))
      if (!node || !block) return
      const anchor = {
        unitId: block.unitId,
        blockIndex: block.blockIndex,
        offset: Math.max(0, (top - node.getBoundingClientRect().top) / zoom),
      }
      saveDocxReadingAnchor(position.fileId, anchor)
      position.save(anchor)
    }
    const onScroll = () => {
      clearTimeout(timer)
      timer = setTimeout(persist, 600)
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      clearTimeout(timer)
      if (timer) persist()
      scroll.removeEventListener('scroll', onScroll)
    }
  }, [root, position, ready, pages, zoom, visiblePages, locate])
}
