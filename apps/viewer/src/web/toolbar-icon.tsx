import React from 'react'

const paths = {
  document: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6M14 2v6h6M8 13h8M8 17h5',
  folder:
    'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7h17a1 1 0 0 1 1 1.3l-3 11.7H3L1 8.3A1 1 0 0 1 2 7h1',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  previous: 'm14 6-6 6 6 6',
  next: 'm10 6 6 6-6 6',
  minus: 'M5 12h14',
  plus: 'M5 12h14M12 5v14',
  width: 'M3 4v16M21 4v16M6 12h12m-9-3-3 3 3 3m6-6 3 3-3 3',
  page: 'M8 3H4v4M16 3h4v4M4 17v4h4M20 17v4h-4M8 8h8v8H8z',
  play: 'm8 5 11 7-11 7V5Z',
  thumbs: 'M3 3h6v8H3zM3 15h6v6H3zM13 3h8v18h-8z',
  outline: 'M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01',
  rotate: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
  info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'm6 6 12 12M6 18 18 6',
  exit: 'M9 4H4v16h5M13 8l4 4-4 4M8 12h13',
  screen: 'M3 4h18v13H3zM8 21h8M12 17v4',
} as const

export function ToolbarIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="viewer-toolbar-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  )
}
