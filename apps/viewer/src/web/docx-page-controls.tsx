import React, { useEffect, useState, type RefObject } from 'react'
import { ViewerBar } from './viewer-bar'
import { ControlButton, ToolbarMore, ZoomControl, contentArea } from './viewer-controls'

/** Page layout starts at 100%; fit-width observes the visible page viewport. */
export function useDocxPageZoom(
  root: RefObject<HTMLDivElement | null>,
  width: number,
  ready: boolean,
) {
  const [zoom, setZoom] = useState(1)
  const [fitWidth, setFitWidth] = useState(false)
  useEffect(() => {
    const element = root.current?.querySelector<HTMLElement>('.pv-scroll')
    if (!fitWidth || !element || !width) return
    const update = () => setZoom(Math.max(0.25, Math.min(3, contentArea(element).width / width)))
    const observer = new ResizeObserver(update)
    observer.observe(element)
    update()
    return () => observer.disconnect()
  }, [fitWidth, width, root, ready])
  const changeZoom = (direction: number) => {
    setFitWidth(false)
    setZoom((value) => Math.max(0.25, Math.min(3, value + direction * 0.1)))
  }
  return {
    zoom,
    fitWidth,
    changeZoom,
    fit: () => setFitWidth(true),
    actualSize: () => {
      setFitWidth(false)
      setZoom(1)
    },
  }
}

export function DocxPageBar({
  controls,
  children,
}: {
  controls: ReturnType<typeof useDocxPageZoom>
  children?: React.ReactNode
}) {
  return (
    <ViewerBar floating label="Word 控制栏">
      <ZoomControl value={controls.zoom} onZoom={controls.changeZoom} />
      <ToolbarMore zoom={{ value: controls.zoom, onZoom: controls.changeZoom }}>
        <ControlButton
          icon="width"
          label="适合宽度"
          aria-pressed={controls.fitWidth}
          onClick={controls.fit}
        >
          适合宽度
        </ControlButton>
        <button type="button" onClick={controls.actualSize}>
          实际大小
        </button>
        {children}
      </ToolbarMore>
    </ViewerBar>
  )
}
