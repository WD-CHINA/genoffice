import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { SlideShowView } from '@genoffice/viewer-renderers/slides/renderer/components/SlideShowView'
import { computePlayOrder } from '@genoffice/viewer-renderers/slides/renderer/slideshow-utils'
import { ControlButton, PageControl } from './viewer-controls'
import { ViewerBar } from './viewer-bar'

type Props = React.ComponentProps<typeof SlideShowView>

// Feed the original player's keyboard interface so animation stepping and hidden pages
// follow the same rules as keyboard, links and the existing presentation menu.
function command(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

export function ViewerSlideShow(props: Props) {
  const host = useRef<HTMLDivElement>(null)
  const order = useMemo(
    () => computePlayOrder(props.slides, props.startAt, props.customOrder),
    [props.slides, props.startAt, props.customOrder],
  )
  const [position, setPosition] = useState(Math.max(0, order.indexOf(props.startAt)))
  const [ended, setEnded] = useState(false)
  const [blocked, setBlocked] = useState(false)
  // Register before the original player's passive key listener. Native select/button
  // keys belong to the controls; commands dispatched on window still reach the player.
  useLayoutEffect(() => {
    const guard = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'b' || event.key === '.') {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      if (!(event.target instanceof Element) || !event.target.closest('.viewer-show-controls'))
        return
      if (event.key === 'Escape') return
      if (event.target.closest('select, input, textarea') || ['Enter', ' '].includes(event.key))
        event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', guard, true)
    return () => window.removeEventListener('keydown', guard, true)
  }, [])
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    const background = [...(host.current?.closest('.viewer-preview')?.children || [])]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== host.current,
      )
      .map((element) => ({ element, inert: element.inert }))
    for (const { element } of background) element.inert = true
    host.current
      ?.querySelector<HTMLButtonElement>('.viewer-show-controls button:not(:disabled)')
      ?.focus()
    return () => {
      for (const { element, inert } of background) element.inert = inert
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [])
  useEffect(() => {
    const original = host.current?.querySelector('.slideshow')
    if (!original) return
    // The original player publishes its play-order position in this counter. Observe
    // that output instead of keeping a competing navigation/animation state machine.
    const sync = () => {
      const count = /^\s*(\d+)\s*\//.exec(original.querySelector('.ss-counter')?.textContent || '')
      if (count) setPosition(Number(count[1]) - 1)
      setEnded(!!original.querySelector('.ss-end'))
      for (const item of original.querySelectorAll<HTMLButtonElement>('.ctx-item')) {
        if (item.querySelector('.ctx-hint')?.textContent?.trim() !== 'B') continue
        item.hidden = true
        item.disabled = true
      }
      setBlocked(!!original.querySelector('.ss-grid, .ctx-menu'))
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(original, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])
  const jump = (number: number) => {
    // Replace any unfinished typed page number before sending the chosen deck page.
    for (const digit of '0000' + number) command(digit)
    command('Enter')
  }
  return (
    <div className="viewer-show-host" ref={host}>
      <SlideShowView {...props} />
      <ViewerBar floating className="viewer-show-controls" label="放映控制栏" hidden={blocked}>
        <span className="viewer-show-status">
          <i />
          {ended ? '放映结束' : '正在放映'}
        </span>
        <PageControl
          format="放映"
          current={position + 1}
          total={order.length}
          previousDisabled={!ended && position === 0}
          onChange={(number) =>
            number === position ? command('ArrowLeft') : jump(order[number - 1]! + 1)
          }
          nextLabel={ended ? '结束放映' : '下一步'}
          onNext={() => command('ArrowRight')}
        />
        <ControlButton
          icon="exit"
          label="退出放映"
          className="viewer-show-exit"
          onClick={() => props.onExit(order[position] ?? props.startAt)}
        >
          退出<span className="viewer-key-hint">Esc</span>
        </ControlButton>
      </ViewerBar>
    </div>
  )
}
