import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sectionFromSectPr, type DocxStyleContext } from '@genoffice/docx-engine'
import {
  reviveDocxStyles,
  docxSectionTypography,
  DOCX_THEME_SANS,
} from '../src/web/docx-style-context'

// All ids in these fixtures are ASCII identifiers; no browser CSSOM is needed.
Object.defineProperty(globalThis, 'CSS', {
  value: { escape: (id: string) => id },
  configurable: true,
})
const base = (): DocxStyleContext => ({
  styles: [],
  numbering: [],
  docDefaults: {
    eaThemeSlot: true,
    sizeHalfPoints: 22,
    lineRule: 'auto',
    lineSpacing: 1.15,
  },
})

test('missing theme references use deterministic bundled faces without changing source defaults', () => {
  const source = base()
  const revived = reviveDocxStyles(source)
  assert.equal(revived.missingThemeFallback, true)
  assert.equal(revived.docDefaults?.eastAsiaFont, DOCX_THEME_SANS)
  assert.equal(revived.docDefaults?.asciiFont, 'Calibri')
  assert.equal(source.docDefaults?.eastAsiaFont, undefined)
  assert.match(revived.css, /--doc-east-asian-font:[^;}]*GenOffice Theme Sans SC/)
  assert.match(revived.css, /--doc-line-mult:1.15/)
  assert.match(revived.css, /font-size:11pt/)
})

test('resolved theme slots and explicit East Asian defaults retain their choices', () => {
  const themed = reviveDocxStyles({
    ...base(),
    themeFonts: { major: 'Cambria', minor: 'Calibri', eastAsia: '' },
  })
  assert.equal(themed.missingThemeFallback, undefined)
  const source = base()
  source.docDefaults!.eastAsiaFont = 'SimSun'
  const literal = reviveDocxStyles(source)
  assert.equal(literal.missingThemeFallback, undefined)
  assert.equal(literal.docDefaults?.eastAsiaFont, 'SimSun')
})

test('Normal and named style typography override document defaults through the shared CSS generator', () => {
  const source = base()
  source.styles = [
    [
      'Normal',
      {
        styleId: 'Normal',
        name: 'Normal',
        type: 'paragraph',
        isDefault: true,
        display: {
          font: 'SimSun',
          fontAscii: 'Calibri',
          eastAsiaFont: 'SimSun',
          sizeHalfPoints: 24,
          lineRule: 'exact',
          lineRawTwips: 360,
        },
      },
    ],
    [
      'Title',
      {
        styleId: 'Title',
        name: 'Title',
        type: 'paragraph',
        basedOn: 'Normal',
        display: { sizeHalfPoints: 32, color: '123456' },
      },
    ],
  ]
  const context = reviveDocxStyles(source)
  assert.match(context.css, /--doc-east-asian-font:[^;}]*SimSun/)
  assert.match(context.css, /font-size:12pt/)
  assert.match(context.css, /line-height:18.0pt/)
  assert.match(context.css, /data-style="Title"[^}]*font-size:16pt/)
  assert.match(context.css, /color:#123456/)
})

test('section grids use the same CSS units for probes and displayed pages', () => {
  const section = sectionFromSectPr(
    '<w:sectPr><w:docGrid w:type="linesAndChars" w:linePitch="360" w:charSpace="4096"/></w:sectPr>',
    0,
    1,
  )
  assert.deepEqual(docxSectionTypography(section.settings), {
    '--doc-grid-pitch': '18pt',
    '--doc-char-space': '1pt',
  })
  assert.deepEqual(docxSectionTypography(), {
    '--doc-grid-pitch': '0.0001px',
    '--doc-char-space': 'normal',
  })
  const context = reviveDocxStyles(base(), { sections: [section] } as any)
  assert.match(context.css, /--doc-line-grid:/)
})
