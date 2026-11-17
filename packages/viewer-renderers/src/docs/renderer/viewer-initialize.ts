import type { Editor } from '@tiptap/core'
import type { ParsedDocFull } from '@genoffice/docx-engine'
import { setNoteNumFmts } from './note-format'
import { setOpenDocumentText } from './text-layout/open-document'
import { documentTextContext } from './text-layout/document-context'
import { setStaticAsciiResolver } from './editor/protected-render'
export function applyDocLayoutSettings(editor: Editor, parsed: ParsedDocFull): void {
  setNoteNumFmts({ footnote: parsed.footnoteProps, endnote: parsed.endnoteProps })
  editor.storage.tabStops.defaultTabStopTwips = parsed.defaultTabStopTwips ?? null
  editor.storage.listNumbering.defaultTabTwips = parsed.defaultTabStopTwips ?? 720
  editor.storage.listNumbering.indentNotTabStop = parsed.indentNotNumberingTabStop === true
  // Word 2013+ justified lines pull words up by shrinking spaces; legacy
  // compatibility modes (and new blank docs) never do
  editor.storage.justifyShrink.enabled = (parsed.compatibilityMode ?? 0) >= 15
  editor.storage.justifyShrink.expandBreakLines = parsed.doNotExpandShiftReturn !== true
  editor.storage.cjkPunctShrink.enabled = parsed.compressPunctuation === true
  editor.storage.cjkPunctShrink.hangPunct = parsed.compressPunctuation !== true
  editor.storage.cjkPunctShrink.legacyLayout = (parsed.compatibilityMode ?? 0) < 15
  editor.storage.cjkPunctShrink.docEastAsiaLang = parsed.docDefaults?.eastAsiaLang ?? null
  setOpenDocumentText(documentTextContext(parsed))
  setStaticAsciiResolver(() => editor.storage.listNumbering)
  // Chromium only hyphenates under an explicit lang (the app shell is zh-CN);
  // scoped to autoHyphenation docs so CJK font fallback is untouched elsewhere
  const lang = parsed.autoHyphenation ? parsed.docDefaults?.lang : undefined
  if (lang) editor.view.dom.setAttribute('lang', lang)
  else editor.view.dom.removeAttribute('lang')
}
