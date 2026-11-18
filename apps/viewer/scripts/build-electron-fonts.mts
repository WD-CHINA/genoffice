import { familyVerticalMetrics } from '../../../packages/font-metrics/src/metrics'
import { faceKey } from '../../../packages/font-metrics/src/resolve'
import { localFaceResource } from './electron-local-faces.mts'
/** Deployment snapshot of the original Electron font resolver, faces and line metrics. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  createSystemFontMetrics,
  resolvedFontResource,
} from '../../../packages/viewer-services/src/slides/main/fonts'
import { shapedMetricsReady } from '../../../packages/viewer-services/src/slides/main/shaped-metrics'
import { fontResolutionKey } from '../src/web/electron-font-catalog'
const root = resolve(import.meta.dirname, '../../..')
const out = process.argv[2] ?? resolve(root, 'apps/viewer/dist/web/electron-fonts')
const catalog = JSON.parse(
  await readFile(resolve(root, 'apps/viewer/src/web/fonts/catalog.json'), 'utf8'),
) as Array<{ names: string[] }>
const names = new Set(catalog.flatMap((f) => f.names).filter((n) => !/ GO$|^GenOffice /i.test(n)))
for (const name of [
  '等线 Light',
  'DengXian Light',
  'DengXian',
  '等线',
  'Arial',
  'Calibri',
  'Calibri Light',
  'Wingdings',
  'Wingdings 2',
  'Wingdings 3',
  'Webdings',
  'Symbol',
  'Helvetica',
  'PingFang SC',
  'Microsoft YaHei UI',
  'Heiti SC',
  'Songti SC',
  'Times New Roman',
  'Viewer Missing Sans',
  'Viewer Missing Serif',
  'Viewer Missing Mono',
])
  names.add(name)
const provider = createSystemFontMetrics(),
  entries = new Map<string, any>(),
  written = new Set<string>(),
  resolutions: Record<string, unknown> = {}
await shapedMetricsReady()
await mkdir(out, { recursive: true })
const samples = {
  '': '',
  arabic: 'العربية',
  hebrew: 'עברית',
  thai: 'ภาษาไทย',
  devanagari: 'हिन्दी',
  kana: 'あ',
  hangul: '가',
  ethiopic: 'አ',
}
for (const char of '•■□▪▫▲►▼◄◊○●◘◙')
  Object.assign(samples, { [`bullet:${char.codePointAt(0)}`]: char })
for (const name of names)
  for (const bold of [false, true])
    for (const italic of [false, true])
      for (const substScript of [undefined, 'ja', 'ko', 'sc', 'tc'] as const)
        for (const latinOnly of [false, true]) {
          const style = { fontFamily: name, fontSizePx: 100, bold, italic, substScript, latinOnly }
          for (const [script, text] of Object.entries(samples)) {
            const family = provider.displayFamily?.(style, text) ?? name
            resolutions[fontResolutionKey(style, script)] = {
              family,
              substituted: !!provider.substituted?.(style),
              metrics: provider.metrics(style),
            }
            const resource = resolvedFontResource(style, family)
            if (!resource) continue
            const id = `electron:${family}|${+resource.bold}${+resource.italic}`
            if (entries.has(id)) continue
            const bytes = new Uint8Array(resource.bytes()),
              hash = createHash('sha256').update(bytes).digest('hex'),
              file = hash + '.ttf'
            if (!written.has(file)) {
              await writeFile(resolve(out, file), bytes)
              written.add(file)
            }
            entries.set(id, {
              id,
              family,
              bold: resource.bold,
              italic: resource.italic,
              names: [family],
              url: file,
              sha256: hash,
            })
          }
        }
// Word's original CSS uses local() aliases with range/metric descriptors.
// Resolve those exact installed faces instead of dropping them on Android.
const wordCss = (
  await readFile(
    resolve(root, 'packages/viewer-renderers/src/docs/renderer/fonts/fonts.css'),
    'utf8',
  )
).replace(/\/\*[\s\S]*?\*\//g, '')
for (const match of wordCss.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
  const props = Object.fromEntries(
    match[1]!.split(';').flatMap((line) => {
      const i = line.indexOf(':')
      return i < 0 ? [] : [[line.slice(0, i).trim(), line.slice(i + 1).trim()]]
    }),
  )
  const family = props['font-family']?.replace(/^['"]|['"]$/g, ''),
    local = [...(props.src ?? '').matchAll(/local\(['"]?([^)'";]+)['"]?\)/g)].map(
      (item) => item[1]!,
    )
  if (!family || !local.length) continue
  const bold = /bold|[6-9]00/.test(props['font-weight'] ?? ''),
    italic = props['font-style'] === 'italic'
  const resource = localFaceResource(local, bold, italic)
  if (!resource) continue
  const bytes = new Uint8Array(resource.bytes()),
    hash = createHash('sha256').update(bytes).digest('hex'),
    file = hash + '.ttf'
  if (!written.has(file)) {
    await writeFile(resolve(out, file), bytes)
    written.add(file)
  }
  const descriptors = Object.fromEntries(
    [
      ['unicode-range', 'unicodeRange'],
      ['size-adjust', 'sizeAdjust'],
      ['ascent-override', 'ascentOverride'],
      ['descent-override', 'descentOverride'],
      ['line-gap-override', 'lineGapOverride'],
    ].flatMap(([css, key]) => (props[css!] ? [[key, props[css!]]] : [])),
  )
  const id = `word:${family}|${+bold}${+italic}|${JSON.stringify(descriptors)}`
  entries.set(id, {
    id,
    family,
    bold,
    italic,
    names: [family],
    url: file,
    sha256: hash,
    descriptors,
  })
}
for (const family of [
  'Microsoft YaHei UI',
  'Heiti SC',
  'Heiti TC',
  'STHeiti',
  'Songti SC',
  'Songti TC',
  'Arial',
  'Helvetica',
  'Times New Roman',
])
  for (const bold of [false, true])
    for (const italic of [false, true]) {
      // v0.13.18 macOS Canvas resolves unavailable Microsoft YaHei UI to
      // PingFang SC (CSS.getPlatformFontsForNode baseline probe). Preserve that
      // fallback for metafile text on hosts with a different generic sans face.
      const localNames = family === 'Microsoft YaHei UI' ? [family, 'PingFang SC'] : [family]
      const resource = localFaceResource(localNames, bold, italic, true)
      if (!resource) continue
      const bytes = new Uint8Array(resource.bytes()),
        hash = createHash('sha256').update(bytes).digest('hex'),
        file = hash + '.ttf'
      if (!written.has(file)) {
        await writeFile(resolve(out, file), bytes)
        written.add(file)
      }
      const id = `word:${family}|${+resource.bold}${+resource.italic}`
      entries.set(id, {
        id,
        family,
        bold: resource.bold,
        italic: resource.italic,
        names: [family],
        url: file,
        sha256: hash,
      })
    }
// PingFang may live in macOS AssetsV2, outside the CSS local() directories.
// Reuse the original resolver's already exported face in that case.
for (const bold of [false, true])
  for (const italic of [false, true]) {
    const id = `word:Microsoft YaHei UI|${+bold}${+italic}`
    if (entries.has(id)) continue
    const face =
      entries.get(`electron:PingFang SC|${+bold}${+italic}`) ??
      entries.get(`electron:PingFang SC|${+bold}0`)
    if (face)
      entries.set(id, {
        ...face,
        id,
        family: 'Microsoft YaHei UI',
        bold,
        italic,
        names: ['Microsoft YaHei UI'],
      })
  }
const wordFaces = JSON.parse(
  await readFile(resolve(root, 'packages/font-metrics/word-faces.json'), 'utf8'),
)
const metricNames = new Set([
  ...names,
  ...Object.keys(wordFaces.faces),
  ...[...entries.values()].map((face) => face.family),
])
const wordMetrics = Object.fromEntries(
  [...metricNames].map((name) => [faceKey(name), familyVerticalMetrics(name)]),
)
await writeFile(
  resolve(out, 'catalog.json'),
  JSON.stringify({
    sourceCommit: 'ac19c54111849d9d8fb2c508223a0389b805c247',
    platform: process.platform,
    entries: [...entries.values()],
    resolutions,
    wordMetrics,
  }),
)
console.log(
  'Electron font snapshot:',
  Object.keys(resolutions).length,
  'resolutions,',
  entries.size,
  'styles,',
  written.size,
  'faces',
)
