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
  'pdf/renderer/PdfPage.tsx',
  'pdf/renderer/LinkLayer.tsx',
  'pdf/renderer/form-catalog.ts',
  'pdf/renderer/view-config.ts',
  'pdf/renderer/heading-outline.ts',
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
    'slides/main/fonts.ts',
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
