import React from 'react'

/** Layout is handled by CSS, keeping controls readable at every viewport width. */
export function ViewerBar({
  className,
  hidden,
  floating = false,
  label = '文档控制栏',
  children,
}: {
  className?: string
  hidden?: boolean
  floating?: boolean
  label?: string
  children: React.ReactNode
}) {
  return (
    <header
      className={`viewer-bar viewer-bar-fit${floating ? ' viewer-floating-bar' : ''}${className ? ` ${className}` : ''}`}
      hidden={hidden}
      role={floating ? 'toolbar' : undefined}
      aria-label={floating ? label : undefined}
    >
      <div className="viewer-bar-track">{children}</div>
    </header>
  )
}
