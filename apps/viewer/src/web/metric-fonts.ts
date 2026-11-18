/** Portable resources plus the deployment snapshot produced by Electron's resolver. */
export { METRIC_FONTS } from './metric-fonts.generated'
export type { MetricFont } from './metric-font-types'
import { METRIC_FONTS } from './metric-fonts.generated'
import { loadElectronFonts } from './electron-font-catalog'
export async function loadMetricFonts() {
  return [...METRIC_FONTS, ...(await loadElectronFonts())]
}
