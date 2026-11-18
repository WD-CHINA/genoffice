import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDocxGridCompat } from '../src/web/docx-grid-compat'

test('old WebViews use Electron numeric grid snapping and paragraph opt-out', () => {
  const savedCss = globalThis.CSS,
    savedStyle = globalThis.getComputedStyle
  const make = (off = false) => ({
    style: {
      values: new Map<string, string>(),
      setProperty(key: string, value: string) {
        this.values.set(key, value)
      },
    },
    closest: () => (off ? {} : null),
  })
  const root = make(),
    child = make(true)
  Object.assign(root, { querySelectorAll: () => [child] })
  globalThis.CSS = { supports: () => false } as any
  globalThis.getComputedStyle = (() => ({
    fontSize: '16px',
    getPropertyValue: (name: string) =>
      ({
        '--doc-line-grid': 'round(up, 20px, 20.8px)',
        '--doc-line-factor': '1.2',
        '--doc-grid-pitch': '15.6pt',
        '--doc-line-mult': '1.5',
      })[name] ?? '',
  })) as any
  try {
    applyDocxGridCompat(root as any)
    assert.ok(Math.abs(parseFloat(root.style.values.get('--doc-line-grid')!) - 20.8) < 1e-9)
    assert.ok(Math.abs(parseFloat(root.style.values.get('--doc-line-max')!) - 31.2) < 1e-9)
    assert.ok(Math.abs(parseFloat(child.style.values.get('--doc-line-max')!) - 28.8) < 1e-9)
  } finally {
    globalThis.CSS = savedCss
    globalThis.getComputedStyle = savedStyle
  }
})
