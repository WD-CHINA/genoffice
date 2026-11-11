/* global document, NodeFilter, getComputedStyle */
/** Browser-side probe: count painted glyphs, excluding the hidden source and clipped lines. */
export function inspectDocxTableFlow(skip = []) {
  return [...document.querySelectorAll('.viewer-doc-remote-page')].flatMap((page) =>
    [...page.querySelectorAll('[data-docx-flow-paint]')].flatMap((paint) => {
      const fragment = paint.closest('.viewer-doc-fragment')
      const key = `${page.dataset.pageIndex}:${fragment.dataset.docxIndex}:${fragment.dataset.sourceFrom}`
      if (skip.includes(key)) return []
      const slice = paint.closest('.viewer-doc-fragment-slice')
      const bounds = slice.getBoundingClientRect()
      const source = fragment.dataset.docxIndex
      const walker = document.createTreeWalker(
        paint.querySelector('.doc-page'),
        NodeFilter.SHOW_TEXT,
      )
      const expected = [],
        visible = [],
        markers = []
      let node,
        textIndex = 0
      while ((node = walker.nextNode())) {
        const id = textIndex++
        if (!node.textContent.trim()) continue
        const parent = node.parentElement
        let top = bounds.top,
          bottom = bounds.bottom
        for (
          let ancestor = parent;
          ancestor && ancestor !== slice;
          ancestor = ancestor.parentElement
        ) {
          const clip = getComputedStyle(ancestor).clipPath
          if (!clip.startsWith('inset(')) continue
          const inset = clip.slice(6, -1).split(/\s+/).map(parseFloat)
          const rect = ancestor.getBoundingClientRect()
          top = Math.max(top, rect.top + inset[0])
          bottom = Math.min(bottom, rect.bottom - (inset[2] ?? inset[0]))
        }
        let paintedText = ''
        for (let i = 0; i < node.length; i++) {
          const char = node.textContent[i]
          if (!char.trim()) continue
          const glyph = `${source}:${id}:${i}`
          expected.push(glyph)
          if (getComputedStyle(parent).visibility === 'hidden') continue
          const range = document.createRange()
          range.setStart(node, i)
          range.setEnd(node, i + 1)
          const rect = range.getBoundingClientRect()
          const center = (rect.top + rect.bottom) / 2
          if (rect.width <= 0 || center < top - 0.1 || center > bottom + 0.1) continue
          visible.push(glyph)
          paintedText += char
        }
        if (/FLOW_(MIDDLE|BOTTOM)/.test(paintedText)) {
          const cell = parent.closest('td,th'),
            rect = parent.getBoundingClientRect(),
            box = cell.getBoundingClientRect()
          markers.push({
            text: paintedText,
            top: rect.top - Math.max(bounds.top, box.top),
            bottom: Math.min(bounds.bottom, box.bottom) - rect.bottom,
            height: rect.height,
          })
        }
      }
      return [{ key, source, expected, visible, markers }]
    }),
  )
}

export function summarizeDocxTableFlow(entries) {
  const expected = new Set(entries.flatMap((entry) => entry.expected))
  const counts = new Map()
  for (const entry of entries)
    for (const key of entry.visible) counts.set(key, (counts.get(key) ?? 0) + 1)
  return {
    fragments: entries.length,
    expected: expected.size,
    visible: counts.size,
    missing: [...expected].filter((key) => !counts.has(key)),
    duplicates: [...counts].filter(([, count]) => count !== 1),
    markers: entries.flatMap((entry) => entry.markers),
  }
}
