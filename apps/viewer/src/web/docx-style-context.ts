import { setOpenDocumentText } from '@genoffice/viewer-renderers/docs/renderer/text-layout/open-document'
import { documentTextContext } from '@genoffice/viewer-renderers/docs/renderer/text-layout/document-context'
import {
  setDocFontTable,
  setEmbeddedLineMetrics,
} from '@genoffice/viewer-renderers/docs/renderer/text-layout/font-rules'
import type {
  DocxStyleContext,
  DocxReadingContext,
  ParsedDocFull,
  SectionSettings,
} from '@genoffice/docx-engine'
import { readSections } from '@genoffice/docx-engine'
import {
  docBodyFont,
  docStyleCss,
  docThemeCss,
} from '@genoffice/viewer-renderers/docs/renderer/doc-style-css'
import {
  docCharSpacePt,
  docGridPitchPt,
  sectionGridPitchPt,
  singleByteCharSpacePt,
} from '@genoffice/viewer-renderers/docs/renderer/pagination'
import { noteEmbeddedFontsChanged } from '@genoffice/viewer-renderers/docs/renderer/line-metrics'

export const DOCX_THEME_SANS = 'GenOffice Theme Sans SC'
// hhea/head of the shipped subset: 1160 / -288 / 0, unitsPerEm=1000.
const themeSansMetrics = { family: DOCX_THEME_SANS, ascent: 1.16, descent: 0.288, lineGap: 0 }

export interface RemoteDocxStyleContext
  extends
    Omit<DocxStyleContext, 'styles' | 'numbering'>,
    Pick<DocxReadingContext, 'footnoteProps' | 'endnoteProps'> {
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
    footnoteProps: reading?.footnoteProps,
    endnoteProps: reading?.endnoteProps,
    styles: new Map(payload.styles),
    numbering: new Map(payload.numbering),
    ...(missingThemeFallback
      ? {
          missingThemeFallback: true as const,
          docDefaults: {
            ...payload.docDefaults,
            eaSlotEmpty: false,
            eaThemeSlot: false,
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
  setOpenDocumentText(documentTextContext(parsed))
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
    setOpenDocumentText(null)
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

/** Original canvas leaves an untyped grid absent: a dummy pitch disables lineLeadPx. */
export function docxCanvasTypography(settings?: SectionSettings): Record<string, string> {
  const vars = docxSectionTypography(settings)
  if (
    !settings ||
    sectionGridPitchPt({ settings } as Parameters<typeof sectionGridPitchPt>[0]) == null
  )
    delete vars['--doc-grid-pitch']
  return vars
}

/** App.tsx's document-wide canvas/preview rules (v0.13.18:3753–3775,8279–8301).
 * Pagination clones are siblings of the measurement canvas, so these rules must
 * reach every .doc-page rather than inherit from the hidden .page-wrap alone.
 * Mixed-section overrides continue to come from the original layout controller.
 */
export function docxDocumentTypography(parsed: ParsedDocFull): string {
  const sections = readSections(parsed)
  const gridPitchPt = docGridPitchPt(sections)
  const mixedGridPitchPt = sections.map(sectionGridPitchPt).find((pitch) => pitch != null)
  const pitch = gridPitchPt ?? mixedGridPitchPt
  const charSpacePt = docCharSpacePt(sections)
  const balancedGrid = parsed.balanceDbcsSpacing === true
  const section = sections[0]?.settings
  return [
    pitch != null ? `.doc-page { --doc-grid-pitch:${pitch}pt }` : '',
    charSpacePt != null
      ? `.doc-page { --doc-char-space:${Math.round(charSpacePt * 10000) / 10000}pt${
          balancedGrid
            ? `; --doc-char-space-sb:${Math.round(singleByteCharSpacePt(charSpacePt, true) * 10000) / 10000}pt`
            : ''
        } }`
      : '',
    balancedGrid
      ? `.doc-page .doc-east-asian-font:not(.doc-east-asian-halfwidth, [style*='letter-spacing'] .doc-east-asian-font, .page-gap-hf *) { letter-spacing: var(--doc-char-space, normal) }`
      : '',
    section
      ? `.doc-page { --doc-margin-left:${section.marginLeft / 15}px; --doc-margin-right:${section.marginRight / 15}px; --doc-margin-top:${section.marginTop / 15}px }`
      : '',
  ].join('\n')
}
