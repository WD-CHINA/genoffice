import {
  prefetchFaces,
  setFontMetricsProvider,
} from '@genoffice/viewer-renderers/docs/renderer/font-resolve'
import { faceKey } from '@genoffice/font-metrics/resolve'
import { cssFontFamily } from '@genoffice/viewer-renderers/docs/renderer/text-layout/font-rules'
import { loadElectronFonts, loadElectronWordMetrics } from './electron-font-catalog'
import { createPptxFontScope } from './pptx-font-scope'
import { bumpHfProbeFontEpoch } from '@genoffice/viewer-renderers/docs/renderer/editor/hf-dom'
import { bumpLineSampleFontEpoch } from '@genoffice/viewer-renderers/docs/renderer/pagination-lines'
import { noteEmbeddedFontsChanged } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'

let installedMetrics: Promise<void> | undefined
async function prepareMetrics() {
  return (installedMetrics ??= (async () => {
    const metrics = await loadElectronWordMetrics()
    setFontMetricsProvider(async (family) => metrics[faceKey(family)] ?? null)
    await prefetchFaces(Object.keys(metrics))
  })())
}

/** Supply actual system faces in Word's original CSS chains, preserving its GO aliases/descriptors. */
export function createDocxNativeFonts() {
  const scope = createPptxFontScope()
  const loadNames = async (names: Set<string>) => {
    await prepareMetrics()
    const catalog = await loadElectronFonts()
    const fonts = catalog.filter(
      (face) =>
        names.has(face.family) &&
        (face.id.startsWith('word:') || !/ GO$|^GenOffice /i.test(face.family)),
    )
    await scope.load(
      {
        fonts,
        measurements: [...names].map((family) => ({
          key: family,
          family,
          text: '',
          bold: false,
          italic: false,
        })),
      },
      async () => null,
    )
    noteEmbeddedFontsChanged(fonts.map((face) => face.family))
    bumpHfProbeFontEpoch()
    bumpLineSampleFontEpoch()
  }
  return {
    async loadFamilies(families: Iterable<string>) {
      const names = new Set<string>()
      for (const family of families)
        for (const name of cssFontFamily(family).split(','))
          names.add(name.trim().replace(/^['"]|['"]$/g, ''))
      await loadNames(names)
    },
    async load(root: HTMLElement) {
      const names = new Set<string>()
      for (const node of [root, ...root.querySelectorAll<HTMLElement>('*')])
        for (const name of getComputedStyle(node).fontFamily.split(','))
          names.add(name.trim().replace(/^['"]|['"]$/g, ''))
      await loadNames(names)
    },
    close: () => scope.close(),
  }
}
