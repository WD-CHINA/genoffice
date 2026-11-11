import type {
  DocxStyleContext,
  DocxReadingContext,
  ParsedDocFull,
  SectionSettings,
} from '@genoffice/docx-engine'
import {
  docBodyFont,
  docStyleCss,
  docThemeCss,
} from '@genoffice/viewer-renderers/docs/renderer/doc-style-css'
import { sectionGridPitchPt } from '@genoffice/viewer-renderers/docs/renderer/pagination'
import {
  noteEmbeddedFontsChanged,
  setDocFontTable,
  setEmbeddedLineMetrics,
} from '@genoffice/viewer-renderers/docs/renderer/line-metrics'

export const DOCX_THEME_SANS = 'GenOffice Theme Sans SC'
// hhea/head of the shipped subset: 1160 / -288 / 0, unitsPerEm=1000.
const themeSansMetrics = { family: DOCX_THEME_SANS, ascent: 1.16, descent: 0.288, lineGap: 0 }

export interface RemoteDocxStyleContext extends Omit<DocxStyleContext, 'styles' | 'numbering'> {
  styles: ParsedDocFull['styles']
  numbering: ParsedDocFull['numbering']
  css: string
  missingThemeFallback?: true
}

/** The legacy CSS generator only reads style data and section markers, never media/body XML. */
export function reviveDocxStyles(
  payload: DocxStyleContext,
  reading?: DocxReadingContext,
  metrics: Parameters<typeof setEmbeddedLineMetrics>[0] = [],
): RemoteDocxStyleContext {
  // A theme reference without a theme part has no face to inherit. Use bundled
  // defaults for those unresolved slots; literal run/style EA choices still win.
  const missingThemeFallback =
    payload.docDefaults?.eaThemeSlot === true &&
    !payload.themeFonts &&
    !payload.docDefaults.eastAsiaFont
  const context = {
    ...payload,
    styles: new Map(payload.styles),
    numbering: new Map(payload.numbering),
    ...(missingThemeFallback
      ? {
          missingThemeFallback: true as const,
          docDefaults: {
            ...payload.docDefaults,
            asciiFont: payload.docDefaults?.asciiFont ?? 'Calibri',
            eastAsiaFont: DOCX_THEME_SANS,
          },
        }
      : {}),
  }
  setDocFontTable(payload.fontTable)
  setEmbeddedLineMetrics([...metrics, ...(missingThemeFallback ? [themeSansMetrics] : [])])
  noteEmbeddedFontsChanged(metrics.map((font) => font.family))
  const parsed = {
    ...context,
    blocks: (reading?.sections ?? []).map((section) => ({
      type: 'paragraph',
      hidden: true,
      docxIndex: section.lastBlockIndex,
      originalXml: section.sectPrXml,
      runs: [],
    })),
  } as unknown as ParsedDocFull
  return {
    ...context,
    css: (
      docStyleCss(parsed) +
      docThemeCss(context.themeFonts, context.themeColors, !!docBodyFont(parsed))
    )
      .replaceAll('.page-wrap', '.viewer-doc-remote')
      .replaceAll('.pv-page', '.viewer-doc-remote-hf'),
  }
}

/** Install before the first hidden measurement; one iframe/session owns this style sheet. */
export function mountDocxStyles(context: RemoteDocxStyleContext, themeSansUrl: string): () => void {
  const sheet = document.createElement('style')
  sheet.dataset.docxStyleContext = '1'
  // Shared header/footer probes key their measurements on this marker.
  sheet.dataset.docCss = 'remote'
  const face = context.missingThemeFallback
    ? `@font-face { font-family:'${DOCX_THEME_SANS}';src:url('${themeSansUrl}') format('woff2');font-display:block }\n`
    : ''
  sheet.textContent = face + context.css
  document.head.append(sheet)
  return () => {
    sheet.remove()
    setEmbeddedLineMetrics([])
    setDocFontTable([])
  }
}

/** Match the section typography in hidden probes, rendered pages and repeated headers. */
export function docxSectionTypography(settings?: SectionSettings): Record<string, string> {
  const pitch = settings
    ? sectionGridPitchPt({ settings } as Parameters<typeof sectionGridPitchPt>[0])
    : null
  const grid = settings?.docGrid
  return {
    '--doc-grid-pitch': pitch != null ? `${pitch}pt` : '0.0001px',
    '--doc-char-space':
      grid?.type === 'linesAndChars' && grid.charSpace != null
        ? `${grid.charSpace / 4096}pt`
        : 'normal',
  }
}
