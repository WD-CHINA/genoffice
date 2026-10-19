import React, { useLayoutEffect, useRef } from 'react'

/** One-row toolbar. When the controls are wider than the window, scale the row down instead of scrolling. */
export function ViewerBar({
  className,
  hidden,
  children,
}: {
  className?: string
  hidden?: boolean
  children: React.ReactNode
}) {
  const bar = useRef<HTMLElement>(null)
  const track = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const outer = bar.current
    const inner = track.current
    if (!outer || !inner) return

    let lastWidth = -1
    const fit = () => {
      const available = outer.clientWidth
      if (!available) return
      lastWidth = available
      inner.style.zoom = '1'
      inner.style.minWidth = 'max-content'
      const natural = inner.offsetWidth
      const scale = natural > available + 1 ? (available - 1) / natural : 1
      if (scale < 1) {
        inner.style.minWidth = 'max-content'
        inner.style.zoom = String(Math.floor(scale * 1000) / 1000)
      } else {
        inner.style.zoom = ''
        inner.style.minWidth = ''
      }
    }

    fit()
    const resize = new ResizeObserver(() => {
      if (outer.clientWidth === lastWidth) return
      fit()
    })
    resize.observe(outer)
    const mutations = new MutationObserver((records) => {
      if (records.every((record) => record.target === inner && record.attributeName === 'style'))
        return
      fit()
    })
    mutations.observe(inner, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'hidden', 'value', 'aria-pressed', 'disabled'],
    })
    return () => {
      resize.disconnect()
      mutations.disconnect()
    }
  }, [])

  return (
    <header
      ref={bar}
      className={`viewer-bar viewer-bar-fit${className ? ` ${className}` : ''}`}
      hidden={hidden}
    >
      <div ref={track} className="viewer-bar-track">
        {children}
      </div>
    </header>
  )
}
