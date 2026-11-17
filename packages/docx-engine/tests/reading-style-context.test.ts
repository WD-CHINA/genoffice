import { describe, expect, it } from 'vitest'
import { parseDocx, readDocxStyleContext, createDocxBlockParser } from '../src/index'
import { buildDocx } from './helpers/build-docx'

describe('remote reading typography context', () => {
  it('carries the same layout settings and font substitution hints as full parsing', async () => {
    const bytes = await buildDocx({
      bodyXml: '<w:p><w:r><w:t>Typography</w:t></w:r></w:p>',
      extraParts: [
        {
          path: 'word/settings.xml',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
          xml: '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:autoHyphenation/><w:compat><w:compatSetting w:name="compatibilityMode" w:val="15"/><w:adjustLineHeightInTable/><w:doNotUseHTMLParagraphAutoSpacing/></w:compat></w:settings>',
        },
        {
          path: 'word/fontTable.xml',
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml',
          xml: '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:font w:name="Custom Font"><w:altName w:val="Arial"/><w:family w:val="swiss"/><w:charset w:val="00"/></w:font></w:fonts>',
        },
      ],
    })
    const [full, context] = await Promise.all([parseDocx(bytes), readDocxStyleContext(bytes)])
    for (const key of [
      'compatibilityMode',
      'autoHyphenation',
      'adjustLineHeightInTable',
      'doNotUseHTMLParagraphAutoSpacing',
      'fontTable',
    ] as const)
      expect(context[key]).toEqual(full[key])
    expect(context.compatibilityMode).toBe(15)
    expect(context.adjustLineHeightInTable).toBe(true)
    expect(context.fontTable?.[0].altName).toBe('Arial')
  })
})

it('streamed reading context retains full-parser notes and separator rules', async () => {
  const bytes = await buildDocx({
    bodyXml: '<w:p><w:r><w:t>Body</w:t><w:footnoteReference w:id="1"/></w:r></w:p>',
    extraParts: [
      {
        path: 'word/footnotes.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        xml: '<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Footnote body</w:t></w:r></w:p></w:footnote></w:footnotes>',
      },
    ],
  })
  const full = await parseDocx(bytes)
  const parser = await createDocxBlockParser(bytes)
  const reading = await parser.readingContext()
  expect(Array.isArray(reading.footnotes)).toBe(true)
  expect(reading.footnotes).toEqual(full.footnotes)
  expect(reading.footnoteSeparator).toEqual(full.footnoteSeparator)
  expect(reading.noteNumbers).toEqual(full.noteNumbers)
})
