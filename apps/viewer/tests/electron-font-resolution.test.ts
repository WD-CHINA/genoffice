import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBundledMetrics } from '../src/web/bundled-metrics'
import { installElectronResolutions, fontResolutionKey } from '../src/web/electron-font-catalog'

// The requested face may be absent on Electron too. Its selected face and native
// line box must drive both browser layout and painting; this is not a load error.
test('uses Electron selected font and line metrics without a false missing-font warning', () => {
  const style = {
    fontFamily: '等线',
    fontSizePx: 20,
    bold: false,
    italic: false,
    substScript: 'sc' as const,
  }
  installElectronResolutions({
    [fontResolutionKey(style)]: {
      family: 'PingFang SC',
      substituted: true,
      metrics: { ascent: 106, descent: 34, lineHeight: 140, externalLeading: 0 },
    },
  })
  try {
    const metrics = createBundledMetrics([
      {
        family: 'PingFang SC',
        bold: false,
        italic: false,
        names: ['PingFang SC'],
        font: {
          unitsPerEm: 1000,
          ascender: 800,
          descender: -200,
          charToGlyphIndex: () => 1,
          getAdvanceWidth: () => 1000,
        } as any,
      },
    ])
    assert.equal(metrics.provider.displayFamily?.(style, '正文'), 'PingFang SC')
    assert.deepEqual(metrics.provider.metrics(style), {
      ascent: 21.200000000000003,
      descent: 6.800000000000001,
      lineHeight: 28,
      externalLeading: 0,
    })
    metrics.provider.measure('正文', style)
    assert.deepEqual(metrics.fallbacks(), [])
    assert.equal(metrics.pendingWidthMeasurements()[0]?.family, 'PingFang SC')
  } finally {
    installElectronResolutions({})
  }
})
