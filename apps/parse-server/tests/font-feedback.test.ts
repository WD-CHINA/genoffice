import { describe, expect, it } from 'vitest'
import { FeedbackMetrics } from '../src/metrics'

describe('browser font feedback', () => {
  it('separates kerning modes across refinement and worker restoration', () => {
    const style = { fontFamily: 'Arial', fontSizePx: 20, bold: false, italic: false }
    const metrics = new FeedbackMetrics()
    metrics.measure('AV', { ...style, kerning: true })
    metrics.measure('AV', { ...style, kerning: false })
    const pending = metrics.pendingWidthMeasurements()
    expect(pending).toHaveLength(2)
    const on = pending.find((item) => item.kerning === true)!
    const off = pending.find((item) => item.kerning === false)!
    expect(on.key).not.toBe(off.key)
    const widths = { [on.key]: 100, [off.key]: 120 }
    metrics.accept(widths)
    expect(metrics.hasPending()).toBe(false)
    const restored = new FeedbackMetrics()
    restored.restore(widths)
    for (const provider of [metrics, restored]) {
      expect(provider.measure('AV', { ...style, kerning: true })).toBe(20)
      expect(provider.measure('AV', { ...style, kerning: false })).toBe(24)
    }
  })
})
