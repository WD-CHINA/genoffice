import { HALFWIDTH_FORM_RE } from '../text-layout/script-rules'
import { Extension } from '@tiptap/core'
import { charClass, isEastAsianChar } from '@genoffice/docx-engine'
import type { Node as PmNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { touchedTopLevelBlocks } from './touched-blocks'

// Font fallback cannot select a script when the Latin face itself covers CJK.
// Decorations keep the text/runs intact, including undo, copying and DOCX export.
// Halfwidth kana/hangul/symbols share the East Asian face but count as
// single-byte text for the balanced character grid (Word probe 2026-10-22).

const EAST_ASIAN_CLASS = 'doc-east-asian-font'
const HALFWIDTH_CLASS = 'doc-east-asian-halfwidth'
const FONT_STYLE = 'font-family:var(--doc-east-asian-font, inherit)'

const classFor = (text: string): string =>
  HALFWIDTH_FORM_RE.test(text) ? `${EAST_ASIAN_CLASS} ${HALFWIDTH_CLASS}` : EAST_ASIAN_CLASS

/** East Asian runs in `text`, split so each piece is uniformly half- or full-width */
export function eastAsianSegments(text: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = []
  let start = -1
  let half = false
  const flush = (end: number) => {
    if (start >= 0) out.push({ index: start, text: text.slice(start, end) })
    start = -1
  }
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i)!
    if (isEastAsianChar(cp)) {
      const h = charClass(cp) === 'halfwidthEA'
      if (start >= 0 && h !== half) flush(i)
      if (start < 0) {
        start = i
        half = h
      }
    } else flush(i)
    i += cp > 0xffff ? 2 : 1
  }
  flush(text.length)
  return out
}

function decorationsIn(doc: PmNode, from: number, to: number): Decoration[] {
  const ranges: Decoration[] = []
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return
    for (const seg of eastAsianSegments(node.text!)) {
      ranges.push(
        // inline-rules: allow — maps each East Asian segment to its script-font span
        Decoration.inline(pos + seg.index, pos + seg.index + seg.text.length, {
          class: classFor(seg.text),
          style: FONT_STYLE,
        }),
      )
    }
  })
  return ranges
}

const key = new PluginKey<DecorationSet>('scriptFonts')

/**
 * styles.css switches the span to the document's Latin chain only while this
 * class sits on the editor root, so the IME pre-edit string resolves Latin
 * glyphs there instead of inheriting the span's EA-only family. prosemirror-view
 * (1.42.x) never sets it — its compositionstart/end handlers only flip
 * `view.input.composing` — so this plugin owns the class for the duration.
 */
const COMPOSING = 'ProseMirror-composing'

export const ScriptFonts = Extension.create({
  name: 'scriptFonts',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) =>
            DecorationSet.create(state.doc, decorationsIn(state.doc, 0, state.doc.content.size)),
          // Rebuilding for the whole document on every keystroke costs blocks×text
          // on long files; only the top-level blocks the transaction touched are
          // rescanned, the rest of the set is mapped through the change.
          apply(tr, old) {
            const composing = editor?.view?.composing
            // an explicit rebuild: the compositionend refresh below
            if (tr.getMeta(key) && !composing)
              return DecorationSet.create(tr.doc, decorationsIn(tr.doc, 0, tr.doc.content.size))
            if (!tr.docChanged) return old
            // The pinyin an IME keeps in the DOM splits the East Asian run in
            // two, so rebuilding the decorations rewrites the text node the
            // composition runs in. Chrome drops the selection with the node —
            // the composition is cancelled and the caret lands past the next
            // bracket. Keep the mapped set until the composition commits.
            if (composing) return old.map(tr.mapping, tr.doc)
            const touched = touchedTopLevelBlocks(tr)
            if (!touched)
              return DecorationSet.create(tr.doc, decorationsIn(tr.doc, 0, tr.doc.content.size))
            let set = old.map(tr.mapping, tr.doc)
            for (const pos of touched) {
              const block = tr.doc.nodeAt(pos)
              if (!block) continue
              const to = pos + block.nodeSize
              set = set.remove(set.find(pos, to))
              set = set.add(tr.doc, decorationsIn(tr.doc, pos, to))
            }
            return set
          },
        },
        props: {
          decorations: (state) => key.getState(state),
          // returning false lets prosemirror-view run its own handler after us
          handleDOMEvents: {
            compositionstart: (view) => {
              view.dom.classList.add(COMPOSING)
              return false
            },
            compositionend: (view) => {
              view.dom.classList.remove(COMPOSING)
              window.setTimeout(() => {
                if (!view.isDestroyed && !view.composing)
                  view.dispatch(view.state.tr.setMeta(key, true))
              })
              return false
            },
          },
        },
        // an editor torn down mid-composition must not leave the class behind
        // (prosemirror-view calls destroy() with no arguments, so close over the view)
        view: (view) => ({ destroy: () => view.dom.classList.remove(COMPOSING) }),
      }),
    ]
  },
})

/** The read-only split pane uses serialized HTML, which has no PM decorations. */
export function scriptFontHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) {
    if (text.parentElement?.closest('script, style, svg, math')) continue
    const segments = eastAsianSegments(text.data)
    if (!segments.length) continue
    const fragment = document.createDocumentFragment()
    let end = 0
    for (const seg of segments) {
      fragment.append(text.data.slice(end, seg.index))
      const span = document.createElement('span')
      span.className = classFor(seg.text)
      span.style.fontFamily = 'var(--doc-east-asian-font, inherit)'
      span.textContent = seg.text
      fragment.append(span)
      end = seg.index + seg.text.length
    }
    fragment.append(text.data.slice(end))
    text.replaceWith(fragment)
  }
  return template.innerHTML
}
