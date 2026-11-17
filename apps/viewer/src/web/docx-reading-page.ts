import type { SectionSettings } from '@genoffice/docx-engine'
import { sectionPageBox } from '@genoffice/viewer-renderers/docs/renderer/pagination-sections'

/** Electron App's docZoomStyle geometry, applied to the continuous paper.
 * The host owns one padding box instead of padding every virtual source unit;
 * crop marks and document-relative objects still need the same inherited vars. */
export function docxReadingPageVars(settings?: SectionSettings): Record<string, string> {
  if (!settings) return {}
  const box = sectionPageBox(settings)
  const top = settings.marginTop / 15,
    bottom = settings.marginBottom / 15
  const left = settings.marginLeft / 15,
    right = settings.marginRight / 15
  const padding = `${top}px ${right}px ${bottom}px ${left}px`
  return {
    '--page-w': `${box.width}px`,
    '--page-h': `${box.height}px`,
    '--section-content-w': `${box.contentWidth}px`,
    '--page-pad': padding,
    '--page-mt': `${top}px`,
    '--page-mb': `${bottom}px`,
    '--page-ml': `${left}px`,
    '--page-mr': `${right}px`,
    '--header-dist': `${box.headerDist}px`,
    '--footer-dist': `${box.footerDist}px`,
  }
}

export function docxReadingPageStyle(settings: SectionSettings): Record<string, string | number> {
  const vars = docxReadingPageVars(settings)
  return { width: sectionPageBox(settings).width, padding: vars['--page-pad'], ...vars }
}
