import React, { useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@genoffice/ui/tokens.css'
import './docx-spike.css'
import {
  pageTops,
  paginateBlocks,
  visiblePages,
  type BlockMeasure,
  type PageDescriptor,
} from './docx-pagination'

const BLOCK_COUNT = 5000
const PAGE_HEIGHT = 900

interface DemoBlock extends BlockMeasure {
  text: string
}

function makeBlocks(): DemoBlock[] {
  return Array.from({ length: BLOCK_COUNT }, (_, index) => ({
    height: 22 + (index % 7) * 6,
    text:
      index % 11 === 0
        ? `Heading ${index + 1}`
        : `Paragraph ${index + 1}: virtual pagination keeps only the visible pages mounted while the document model stays block-based.`,
    keepWithNext: index % 11 === 0,
  }))
}

function Page({ page, blocks, top }: { page: PageDescriptor; blocks: DemoBlock[]; top: number }) {
  return (
    <article
      className="docx-page"
      style={{ transform: `translateY(${top}px)`, height: page.height }}
    >
      <span className="docx-page-number">{page.index + 1}</span>
      {blocks.slice(page.blockStart, page.blockEnd).map((block, index) => (
        <p
          key={page.blockStart + index}
          className={block.text.startsWith('Heading') ? 'docx-block is-heading' : 'docx-block'}
          style={{ height: block.height }}
        >
          {block.text}
        </p>
      ))}
    </article>
  )
}

function Spike() {
  const blocks = useMemo(makeBlocks, [])
  const pages = useMemo(() => paginateBlocks(blocks, PAGE_HEIGHT), [blocks])
  const tops = useMemo(() => pageTops(pages), [pages])
  const totalHeight = tops[tops.length - 1] + pages[pages.length - 1].height
  const [scrollTop, setScrollTop] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)
  const viewportHeight = viewport.current?.clientHeight || 720
  const range = visiblePages(
    tops,
    pages.map((page) => page.height),
    scrollTop,
    viewportHeight,
    2,
  )

  return (
    <main className="docx-spike">
      <header className="docx-spike-head">
        <a href="/">Office Viewer</a>
        <h1>DOCX 虚拟分页 Spike</h1>
        <p>
          合成 {BLOCK_COUNT} 个 block，按测量高度分页，只挂载可见页
          ±2。这里验证的是分页/虚拟列表数学， 还没有接 Tiptap 按页挂载。
        </p>
      </header>
      <section className="docx-spike-stats">
        <span>blocks: {blocks.length}</span>
        <span>pages: {pages.length}</span>
        <span>
          mounted: {range.start + 1}–{range.end} ({range.end - range.start})
        </span>
        <span>scrollTop: {Math.round(scrollTop)}</span>
      </section>
      <div
        className="docx-spike-viewport"
        ref={viewport}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="docx-spike-canvas" style={{ height: totalHeight }}>
          {pages.slice(range.start, range.end).map((page) => (
            <Page key={page.index} page={page} blocks={blocks} top={tops[page.index]} />
          ))}
        </div>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Spike />)
