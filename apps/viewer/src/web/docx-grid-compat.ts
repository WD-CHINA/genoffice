import { snapLineToPitch } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'

/** CSS round() is absent in older Android WebViews. Evaluate the original numerical twin. */
export function applyDocxGridCompat(root: HTMLElement) {
  if (CSS.supports('line-height', 'round(up, 20px, 12px)')) return
  const pending: Array<{ node: HTMLElement; single: number; maximum?: number }> = []
  for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    const cs = getComputedStyle(node)
    // Previously materialized values are refreshed after DOM/font/section changes too.
    if (!cs.getPropertyValue('--doc-line-grid')) continue
    const factor = parseFloat(cs.getPropertyValue('--doc-line-factor')) || 1.2
    const size = parseFloat(cs.fontSize),
      rawPitch = cs.getPropertyValue('--doc-grid-pitch').trim()
    const pitch = parseFloat(rawPitch) * (/pt$/.test(rawPitch) ? 4 / 3 : 1) || 0.0001
    const mult = parseFloat(cs.getPropertyValue('--doc-line-mult')) || 1
    const single = snapLineToPitch(factor * size, pitch)
    const offGrid = !!node.closest('.doc-nosnap,.doc-grid-nosnap')
    pending.push({
      node,
      single,
      maximum: offGrid ? factor * size * mult : Math.max(mult * pitch, single),
    })
  }
  for (const { node, single, maximum } of pending) {
    node.style.setProperty('--doc-line-grid', single + 'px')
    if (maximum !== undefined) node.style.setProperty('--doc-line-max', maximum + 'px')
  }
}
