import type { RenderNode, ShapeRenderNode } from '@genoffice/pptx-render'
import type { LinkTargetOp } from '../shared/ipc'
export function hitLink(
  nodes: RenderNode[],
  x: number,
  y: number,
  links: Map<string, LinkTargetOp>,
  runLinks: Map<string, LinkTargetOp>,
): LinkTargetOp | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!
    const { box } = n
    if (x < box.x || y < box.y || x > box.x + box.w || y > box.y + box.h) continue
    if (n.type === 'group') {
      const inner = hitLink(n.children, x - box.x, y - box.y, links, runLinks)
      if (inner) return inner
    }
    // Run-level link on the glyph under the pointer beats the whole-element link (more specific)
    const text = (n as ShapeRenderNode).text
    if (text && runLinks.size) {
      let para = -1
      for (const ln of text.lines) {
        if (ln.paraStart !== false) para++
        const ly = box.y + text.insets.t + ln.top
        if (y < ly || y > ly + ln.height) continue
        for (const r of ln.runs) {
          if (r.srcRunIdx == null) continue
          const rx = box.x + text.insets.l + r.x
          if (x < rx || x > rx + r.widthPx) continue
          const target = runLinks.get(`${n.sourceId}:${para}:${r.srcRunIdx}`)
          if (target) return target
        }
      }
    }
    const target = links.get(n.sourceId)
    if (target) return target
  }
  return null
}
