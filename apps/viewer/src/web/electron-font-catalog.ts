import type { FaceVerticalMetrics } from '@genoffice/font-metrics'
import type { RunStyle } from '@genoffice/pptx-render'
import type { MetricFont } from './metric-font-types'
import { fontName } from './font-selection'
import { classifyFamily } from '@genoffice/viewer-services/slides/shared/font-family-class'
import { complexScriptOf } from '@genoffice/viewer-services/slides/shared/font-text-script'
import {
  classifyCjkScript,
  classifyCjkScriptByNameScript,
} from '@genoffice/viewer-renderers/slides/shared/cjk-script'

export interface ElectronFontResolution {
  family: string
  substituted: boolean
  metrics: { ascent: number; descent: number; lineHeight: number; externalLeading?: number }
}
let resolutions: Record<string, ElectronFontResolution> = {}
// Source script-fallback.ts checks language-gated Kana/Hangul before shaping.
export function fontTextScript(text = '') {
  if (/[가-힣]/.test(text)) return 'hangul'
  if (/[぀-ヿ]/.test(text)) return 'kana'
  if (/[\u1200-\u139f\u2d80-\u2ddf\uab00-\uab2f]/.test(text)) return 'ethiopic'
  if (/^[•■□▪▫▲►▼◄◊○●◘◙]+$/.test(text)) return `bullet:${text.codePointAt(0)}`
  return complexScriptOf(text) ?? ''
}
export function fontResolutionKey(style: RunStyle, script = '') {
  return `${fontName(style.fontFamily)}|${+!!style.bold}${+!!style.italic}|${style.substScript ?? ''}|${+!!style.latinOnly}|${script}`
}
export function installElectronResolutions(value: typeof resolutions) {
  resolutions = value
}
export function electronFontResolution(style: RunStyle, text = '') {
  const script = fontTextScript(text),
    direct = resolutions[fontResolutionKey(style, script)]
  if (direct) return direct
  const kind = classifyFamily(style.fontFamily)
  return resolutions[
    fontResolutionKey(
      {
        ...style,
        fontFamily:
          kind === 'mono'
            ? 'Viewer Missing Mono'
            : kind === 'serif'
              ? 'Viewer Missing Serif'
              : 'Viewer Missing Sans',
        substScript:
          style.substScript ??
          (style.latinOnly
            ? classifyCjkScriptByNameScript(style.fontFamily)
            : classifyCjkScript(style.fontFamily)) ??
          undefined,
      },
      script,
    )
  ]
}
let wordMetrics: Record<string, FaceVerticalMetrics | null> = {}
export async function loadElectronWordMetrics() {
  await loadElectronFonts()
  return wordMetrics
}
let loading: Promise<MetricFont[]> | undefined
export function loadElectronFonts(): Promise<MetricFont[]> {
  return (loading ??= (async () => {
    const url = new URL(
      `${import.meta.env.BASE_URL}electron-fonts/catalog.json`,
      self.location.href,
    )
    const response = await fetch(url)
    if (!response.ok) throw new Error('缺少 Electron 字体快照，请重新构建 Viewer')
    const snapshot = (await response.json()) as {
      entries: MetricFont[]
      resolutions: typeof resolutions
      wordMetrics?: typeof wordMetrics
    }
    if (!snapshot.resolutions) throw new Error('Electron 字体快照格式无效，请重新构建 Viewer')
    installElectronResolutions(snapshot.resolutions)
    wordMetrics = snapshot.wordMetrics ?? {}
    return snapshot.entries.map((font) => ({ ...font, url: new URL(font.url, url).href }))
  })())
}
