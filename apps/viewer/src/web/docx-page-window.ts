import { useEffect, useState, type RefObject } from 'react'

/** Mount original page JSX near the viewport while retaining every sheet's exact box. */
export function useDocxPageWindow(
  root: RefObject<HTMLElement | null>,
  pages: number,
  epoch: number,
  ready: boolean,
) {
  const [visible, setVisible] = useState<ReadonlySet<number>>(() => new Set([0, 1]))
  useEffect(() => {
    const host = root.current
    if (!host || !ready) return
    let frame = 0
    const refresh = () => {
      frame = 0
      const scroll = host.querySelector<HTMLElement>('.pv-scroll')
      if (!scroll) return
      const bounds = scroll.getBoundingClientRect()
      const next = new Set<number>()
      for (const page of scroll.querySelectorAll<HTMLElement>('.pv-page')) {
        const rect = page.getBoundingClientRect()
        if (rect.bottom >= bounds.top - bounds.height && rect.top <= bounds.bottom + bounds.height)
          next.add(Number(page.dataset.pvPage))
      }
      setVisible((old) =>
        old.size === next.size && [...old].every((i) => next.has(i)) ? old : next,
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(refresh)
    }
    // Preview creates/replaces its sheet DOM after the parent's ready effect.
    // Observe those commits, including single-page documents whose count stays 1.
    const observer = new MutationObserver(schedule)
    observer.observe(host, { childList: true, subtree: true })
    host.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer.disconnect()
      host.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [root, pages, epoch, ready])
  return visible
}
