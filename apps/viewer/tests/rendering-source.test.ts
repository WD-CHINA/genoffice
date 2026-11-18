import ts from 'typescript'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const core = [
  'slides/renderer/SlideThumb.tsx',
  'slides/renderer/NodeBody.tsx',
  'slides/renderer/ChartBody.tsx',
  'slides/renderer/konva-adapter.ts',
  'slides/renderer/animation-play.ts',
  'slides/renderer/components/AnimatedSlide.tsx',
  'slides/renderer/text-warp.ts',
  // PDF page rendering and auxiliary readers have private failure-isolation
  // adapters, covered by pdf-page-isolation.test.ts and the browser smoke.
  'pdf/renderer/view-config.ts',
  'pdf/renderer/OutlinePanel.tsx',
  'pdf/renderer/annotation-catalog.ts',
  'pdf/renderer/note-threads.ts',
  'pdf/renderer/note-margin-layout.ts',
  'pdf/renderer/NoteMargin.tsx',
  'pdf/renderer/DrawLayer.tsx',
  'docs/renderer/hf-phantom.ts',
  'docs/renderer/pagination-sections.ts',
  'docs/renderer/pagination-lines.ts',
  'docs/renderer/pagination-slices.ts',
  'docs/renderer/pagination-measure.ts',
  'docs/renderer/pagination-hf.ts',
  'docs/renderer/editor/convert.ts',
  'docs/renderer/line-metrics.ts',
  'docs/renderer/doc-style-css.ts',
  'docs/renderer/pagination.ts',
  'docs/renderer/styles.css',
]
test('keeps core drawing, playback and Word pagination identical to original sources', async () => {
  const repo = new URL('../../../', import.meta.url)
  for (const path of core) {
    const [format, ...parts] = path.split('/')
    const original = new URL(`apps/${format}/src/${parts.join('/')}`, repo)
    const snapshot = new URL(`packages/viewer-renderers/src/${path}`, repo)
    assert.deepEqual(await readFile(snapshot), await readFile(original), path)
  }
})
test('keeps private font resolution and media decoding identical to original services', async () => {
  const repo = new URL('../../../', import.meta.url)
  for (const path of [
    'slides/main/font-scan.ts',
    'slides/main/tiff-decode.ts',
    'slides/main/jpeg-orientation.ts',
  ]) {
    const [format, ...parts] = path.split('/')
    assert.deepEqual(
      await readFile(new URL(`packages/viewer-services/src/${path}`, repo)),
      await readFile(new URL(`apps/${format}/src/${parts.join('/')}`, repo)),
      path,
    )
  }
})

/** Only the enumerated module/asset bindings and transport exports are private.
 * Every token of the resolver, byte extraction, shaping and scan core stays checked. */
function nativeCore(text: string, kind: 'fonts' | 'shaped') {
  const file = ts.createSourceFile('native.ts', text, ts.ScriptTarget.Latest, true)
  const bindings = new Set(
    kind === 'fonts'
      ? [
          'carlitoRegular',
          'carlitoBold',
          'carlitoItalic',
          'carlitoBoldItalic',
          'requireTypeface',
          'opentype',
        ]
      : ['requireFont', 'hbRoot', 'createHarfBuzz', 'hbWasmPath'],
  )
  const adapters = new Set([
    'resolvedFontResource',
    'createTransportFontMetrics',
    'pendingWidthMeasurements',
    'acceptWidthMeasurements',
  ])
  const keep = file.statements
    .filter((node) => {
      if (ts.isImportDeclaration(node)) {
        const path = (node.moduleSpecifier as ts.StringLiteral).text
        return (
          !['node:url', 'node:module', 'node:path', 'opentype.js'].includes(path) &&
          !path.endsWith('?asset') &&
          !path.includes('harfbuzzjs/')
        )
      }
      if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.every(
          (d) => ts.isIdentifier(d.name) && bindings.has(d.name.text),
        )
      )
        return false
      return !(ts.isFunctionDeclaration(node) && node.name && adapters.has(node.name.text))
    })
    .map((n) => n.getText(file))
    .join('\n')
  return ts
    .createPrinter({ removeComments: true })
    .printFile(ts.createSourceFile('core.ts', keep, ts.ScriptTarget.Latest, true))
}
test('native font resolver and HarfBuzz cores retain all upstream tokens outside named host bindings', async () => {
  const repo = new URL('../../../', import.meta.url)
  for (const [name, kind] of [
    ['fonts', 'fonts'],
    ['shaped-metrics', 'shaped'],
  ] as const) {
    const original = await readFile(new URL(`apps/slides/src/main/${name}.ts`, repo), 'utf8')
    const snapshot = await readFile(
      new URL(`packages/viewer-services/src/slides/main/${name}.ts`, repo),
      'utf8',
    )
    assert.deepEqual(nativeCore(snapshot, kind), nativeCore(original, kind), name)
  }
})

test('browser metafile font record scanners retain the original EMF/WMF implementations', async () => {
  const repo = new URL('../../../', import.meta.url)
  const names = new Set(['utf16', 'add', 'scanEmfPlus', 'scanEmf', 'scanWmf'])
  const scanners = (text: string) => {
    const source = ts.createSourceFile('scan.ts', text, ts.ScriptTarget.Latest, true)
    const nodes = source.statements.filter(
      (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''),
    )
    assert.equal(nodes.length, names.size)
    return nodes.map((node) =>
      ts.createPrinter({ removeComments: true }).printNode(ts.EmitHint.Unspecified, node, source),
    )
  }
  const [original, browser] = await Promise.all([
    readFile(new URL('apps/slides/src/main/metafile-fonts.ts', repo), 'utf8'),
    readFile(new URL('packages/viewer-services/src/slides/shared/metafile-fonts.ts', repo), 'utf8'),
  ])
  assert.deepEqual(scanners(browser), scanners(original))
})
