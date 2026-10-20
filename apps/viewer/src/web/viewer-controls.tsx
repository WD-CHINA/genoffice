import React, { useEffect, useRef } from 'react'
import { ToolbarIcon } from './toolbar-icon'

export function ControlButton({
  icon,
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: React.ComponentProps<typeof ToolbarIcon>['name']
  label: string
}) {
  return (
    <button type="button" aria-label={label} title={label} {...props}>
      <ToolbarIcon name={icon} />
      {children && <span className="viewer-control-label">{children}</span>}
    </button>
  )
}

export function PageControl({
  format,
  current,
  total,
  onChange,
  nextLabel = '下一页',
  onNext,
  previousDisabled,
}: {
  format: string
  current: number
  total: number
  onChange: (page: number) => void
  nextLabel?: string
  onNext?: () => void
  previousDisabled?: boolean
}) {
  return (
    <div
      className="viewer-toolbar-group viewer-page-controls"
      role="group"
      aria-label={`${format} 页面导航`}
    >
      <ControlButton
        icon="previous"
        label="上一页"
        disabled={previousDisabled ?? current <= 1}
        onClick={() => onChange(current - 1)}
      />
      <label className="viewer-page-picker">
        <span className="viewer-sr-only">页码</span>
        <select
          aria-label={`${format} 页码`}
          title={`第 ${current} 页，共 ${total} 页`}
          value={current}
          disabled={!total}
          onChange={(event) => onChange(Number(event.target.value))}
        >
          {Array.from({ length: total || 1 }, (_, index) => (
            <option key={index} value={index + 1}>
              第 {index + 1} 页
            </option>
          ))}
        </select>
        <span className="viewer-mobile-page-value" aria-hidden="true">
          {current} / {total}
        </span>
      </label>
      <span className="viewer-page-count">/ {total}</span>
      <ControlButton
        icon="next"
        label={nextLabel}
        disabled={!onNext && current >= total}
        onClick={onNext || (() => onChange(current + 1))}
      />
    </div>
  )
}

export function ZoomControl({
  value,
  onZoom,
  mobileOnly = false,
}: {
  value: number
  onZoom: (direction: number) => void
  mobileOnly?: boolean
}) {
  return (
    <div
      className={`viewer-toolbar-group viewer-zoom-controls${mobileOnly ? ' viewer-mobile-zoom' : ''}`}
      role="group"
      aria-label="缩放"
    >
      <ControlButton icon="minus" label="缩小" onClick={() => onZoom(-1)}>
        {mobileOnly && '缩小'}
      </ControlButton>
      <output className="viewer-zoom-value" aria-label="缩放比例">
        {Math.round(value * 100)}%
      </output>
      <ControlButton icon="plus" label="放大" onClick={() => onZoom(1)}>
        {mobileOnly && '放大'}
      </ControlButton>
    </div>
  )
}

export function ToolbarMore({
  children,
  zoom,
}: {
  children: React.ReactNode
  zoom?: { value: number; onZoom: (direction: number) => void }
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) ref.current.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !ref.current?.open) return
      event.preventDefault()
      event.stopPropagation()
      ref.current.open = false
      ref.current.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  return (
    <details className="viewer-toolbar-more" ref={ref}>
      <summary aria-label="更多操作" title="更多操作">
        <ToolbarIcon name="more" />
        <span>更多</span>
      </summary>
      <div
        className="viewer-more-panel"
        onClick={(event) => {
          const target = event.target as Element
          if (target.closest('button') && !target.closest('.viewer-mobile-zoom') && ref.current)
            ref.current.open = false
        }}
      >
        {zoom && <ZoomControl {...zoom} mobileOnly />}
        {children}
      </div>
    </details>
  )
}

export function FitControls({
  fit,
  onFit,
}: {
  fit: 'width' | 'page' | null
  onFit: (mode: 'width' | 'page') => void
}) {
  return (
    <>
      <ControlButton
        icon="width"
        label="适合宽度"
        aria-pressed={fit === 'width'}
        onClick={() => onFit('width')}
      >
        适合宽度
      </ControlButton>
      <ControlButton
        icon="page"
        label="适合页面"
        aria-pressed={fit === 'page'}
        onClick={() => onFit('page')}
      >
        适合页面
      </ControlButton>
    </>
  )
}

/** Use document padding for fit calculations; floating controls reserve no content space. */
export function contentArea(element: HTMLElement) {
  const style = getComputedStyle(element)
  return {
    width: Math.max(
      1,
      element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    ),
    height: Math.max(
      1,
      element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
    ),
  }
}
