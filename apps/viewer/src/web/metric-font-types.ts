/** Descriptors shared by worker metrics and the browser's actual FontFace. */
export interface MetricFont {
  id: string
  family: string
  bold: boolean
  italic: boolean
  url: string
  names: string[]
  descriptors?: {
    unicodeRange?: string
    sizeAdjust?: string
    ascentOverride?: string
    descentOverride?: string
    lineGapOverride?: string
  }
  metricsUrl?: string
  tuneWin?: boolean
}
