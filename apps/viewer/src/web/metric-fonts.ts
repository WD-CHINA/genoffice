import carlitoRegular from '@genoffice/ui/fonts/Carlito-Regular.ttf?url'
import carlitoBold from '@genoffice/ui/fonts/Carlito-Bold.ttf?url'
import carlitoItalic from '@genoffice/ui/fonts/Carlito-Italic.ttf?url'
import carlitoBoldItalic from '@genoffice/ui/fonts/Carlito-BoldItalic.ttf?url'
import caladeaRegular from '@genoffice/viewer-renderers/docs/renderer/fonts/Caladea-Regular.ttf?url'
import caladeaBold from '@genoffice/viewer-renderers/docs/renderer/fonts/Caladea-Bold.ttf?url'
import caladeaItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/Caladea-Italic.ttf?url'
import caladeaBoldItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/Caladea-BoldItalic.ttf?url'
import liberationSans from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSans-Regular.ttf?url'
import liberationSansBold from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSans-Bold.ttf?url'
import liberationSansItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSans-Italic.ttf?url'
import liberationSansBoldItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSans-BoldItalic.ttf?url'
import liberationSerif from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSerif-Regular.ttf?url'
import liberationSerifBold from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSerif-Bold.ttf?url'
import liberationSerifItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSerif-Italic.ttf?url'
import liberationSerifBoldItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationSerif-BoldItalic.ttf?url'
import liberationMono from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationMono-Regular.ttf?url'
import liberationMonoBold from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationMono-Bold.ttf?url'
import liberationMonoItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationMono-Italic.ttf?url'
import liberationMonoBoldItalic from '@genoffice/viewer-renderers/docs/renderer/fonts/LiberationMono-BoldItalic.ttf?url'
import notoCjk from '@genoffice/viewer-renderers/docs/renderer/fonts/NotoSansCJKsc-Regular-subset.woff2?url'
import notoSerif from '@genoffice/viewer-renderers/docs/renderer/fonts/NotoSerifCJKsc-Regular-subset.woff2?url'
import notoArabic from '@genoffice/viewer-renderers/docs/renderer/fonts/NotoNaskhArabic-Regular-subset.woff2?url'

export interface MetricFont {
  family: string
  bold: boolean
  italic: boolean
  url: string
  names: string[]
  tuneWin?: boolean
}

/** Metric-compatible faces already shipped with the viewer. Office names are registered too. */
export const METRIC_FONTS: MetricFont[] = [
  face('Carlito', carlitoRegular, ['Calibri', 'Calibri Light'], false, false, true),
  face('Carlito', carlitoBold, ['Calibri', 'Calibri Light'], true, false, true),
  face('Carlito', carlitoItalic, ['Calibri', 'Calibri Light'], false, true, true),
  face('Carlito', carlitoBoldItalic, ['Calibri', 'Calibri Light'], true, true, true),
  face('Caladea', caladeaRegular, ['Cambria'], false, false),
  face('Caladea', caladeaBold, ['Cambria'], true, false),
  face('Caladea', caladeaItalic, ['Cambria'], false, true),
  face('Caladea', caladeaBoldItalic, ['Cambria'], true, true),
  face('Liberation Sans', liberationSans, ['Arial', 'Helvetica', 'Helvetica Neue'], false, false),
  face('Liberation Sans', liberationSansBold, ['Arial', 'Helvetica', 'Helvetica Neue'], true, false),
  face('Liberation Sans', liberationSansItalic, ['Arial', 'Helvetica', 'Helvetica Neue'], false, true),
  face('Liberation Sans', liberationSansBoldItalic, ['Arial', 'Helvetica', 'Helvetica Neue'], true, true),
  face('Liberation Serif', liberationSerif, ['Times New Roman', 'Times'], false, false),
  face('Liberation Serif', liberationSerifBold, ['Times New Roman', 'Times'], true, false),
  face('Liberation Serif', liberationSerifItalic, ['Times New Roman', 'Times'], false, true),
  face('Liberation Serif', liberationSerifBoldItalic, ['Times New Roman', 'Times'], true, true),
  face('Liberation Mono', liberationMono, ['Courier New', 'Courier'], false, false),
  face('Liberation Mono', liberationMonoBold, ['Courier New', 'Courier'], true, false),
  face('Liberation Mono', liberationMonoItalic, ['Courier New', 'Courier'], false, true),
  face('Liberation Mono', liberationMonoBoldItalic, ['Courier New', 'Courier'], true, true),
  face('Noto Sans CJK SC', notoCjk, ['Microsoft YaHei', '微软雅黑', 'SimHei', '黑体'], false, false),
  face('Noto Serif CJK SC', notoSerif, ['SimSun', '宋体'], false, false),
  face('Noto Naskh Arabic', notoArabic, ['Tahoma', 'Geeza Pro'], false, false),
]

function face(
  family: string,
  url: string,
  names: string[],
  bold: boolean,
  italic: boolean,
  tuneWin = false,
): MetricFont {
  return { family, url, names: [family, ...names], bold, italic, tuneWin }
}
