/**
 * CodeMirror 6 wrapper for raw markdown source editing.
 * Provides a VS Code-themed editor with markdown syntax highlighting.
 */

import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Transaction, RangeSetBuilder } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { closeBrackets } from '@codemirror/autocomplete';

const vscodeTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--vscode-editor-background)',
    color: 'var(--vscode-editor-foreground)',
    fontSize: 'inherit',
    fontFamily: 'var(--vscode-editor-font-family, Consolas, monospace)',
  },
  '.cm-content': {
    caretColor: 'var(--vscode-editorCursor-foreground, #fff)',
    padding: '4px 0',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--vscode-editor-background)',
    color: 'var(--vscode-editorLineNumber-foreground, rgba(128,128,128,0.45))',
    borderRight: '1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.2))',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editorLineNumber-activeForeground, #c6c6c6)',
  },
  '.cm-activeLine': {
    backgroundColor: 'var(--vscode-editor-lineHighlightBackground, rgba(255,255,255,0.04))',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--vscode-editor-selectionBackground, rgba(64,128,208,0.3)) !important',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--vscode-editorCursor-foreground, #fff)',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  // Reset CM heading styles inside frontmatter lines
  '.cm-frontmatter-line span': {
    fontSize: 'inherit !important',
    fontWeight: 'inherit !important',
  },
}, { dark: true });

/** Syntax highlight style — render markdown formatting naturally */
const vscodeHighlightStyle = HighlightStyle.define([
  // Headings — bold, blue, scaled
  { tag: tags.heading, fontWeight: 'bold', color: '#4fc1ff' },
  { tag: tags.heading1, fontSize: '1.5em' },
  { tag: tags.heading2, fontSize: '1.3em' },
  { tag: tags.heading3, fontSize: '1.15em' },
  { tag: tags.heading4, fontSize: '1.05em' },
  { tag: tags.heading5, fontSize: '1em' },
  { tag: tags.heading6, fontSize: '0.9em', fontStyle: 'italic' },
  // **bold** — actually bold
  { tag: tags.strong, fontWeight: 'bold' },
  // *italic* — actually italic
  { tag: tags.emphasis, fontStyle: 'italic' },
  // ~~strikethrough~~ — actually struck through
  { tag: tags.strikethrough, textDecoration: 'line-through', opacity: '0.7' },
  // Links
  { tag: tags.link, color: '#61afef', textDecoration: 'underline' },
  { tag: tags.url, color: '#61afef' },
  // `inline code` — monospace with background
  { tag: tags.monospace, color: '#d19a66', fontFamily: 'var(--vscode-editor-font-family, Consolas, monospace)' },
  // > blockquote — italic, larger
  { tag: tags.quote, color: '#98c379', fontStyle: 'italic', fontSize: '1.05em' },
  // Markdown syntax chars (**, *, `, ~~, ## etc.) — dimmed
  { tag: tags.processingInstruction, color: '#6b7280' },
  // Meta (frontmatter, HTML comments)
  { tag: tags.meta, color: '#7f848e' },
  // --- horizontal rule
  { tag: tags.contentSeparator, color: '#abb2bf' },
  // List markers (-, *, 1.)
  { tag: tags.list, color: '#e5c07b' },
  // Keyword
  { tag: tags.keyword, color: '#c586c0' },
  // String
  { tag: tags.string, color: '#ce9178' },
  // Comment
  { tag: tags.comment, color: '#6a9955', fontStyle: 'italic' },
]);

// ─── Custom markdown decorations (elements without CM tags) ──────────────

const CALLOUT_RE = /^>\s*\[!(note|tip|warning|caution|important|info|success|danger|bug|example|quote|abstract|todo|faq|question|failure|error)\]/i;
const CALLOUT_COLORS: Record<string, string> = {
  note: '#61afef', info: '#61afef', abstract: '#61afef', faq: '#61afef', question: '#61afef',
  tip: '#4ec9b0', success: '#4ec9b0',
  warning: '#e5c07b', todo: '#e5c07b',
  caution: '#e06c75', danger: '#e06c75', error: '#e06c75', failure: '#e06c75', bug: '#e06c75',
  important: '#c678dd', example: '#c678dd',
  quote: '#98c379',
};

// Inline pattern decorations
const HIGHLIGHT_RE = /==[^=]+==/g;                    // ==highlighted==
const MATH_INLINE_RE = /(?<!\$)\$(?!\$)([^$\n]+)\$/g; // $math$
const MATH_BLOCK_RE = /^\$\$/;                         // $$ block delimiter
const DIFF_ADD_RE = /\{\+[^}]+\+\}/g;                 // {+ added +}
const DIFF_DEL_RE = /\{-[^}]+-\}/g;                   // {- removed -}
const FOOTNOTE_RE = /\[\^[^\]]+\]/g;                   // [^1] or [^label]
const TABLE_RE = /^\|(.+\|)+\s*$/;                     // | col | col |
const CHECKBOX_CHECKED_RE = /^(\s*[-*+]\s+)\[x\]/i;   // - [x]
const CHECKBOX_UNCHECKED_RE = /^(\s*[-*+]\s+)\[ \]/;   // - [ ]
const TOC_RE = /^\[\[toc\]\]$/i;                       // [[toc]]
const STRIKETHROUGH_RE = /~~[^~]+~~/g;                  // ~~strikethrough~~
const UNDERLINE_RE = /(?<!\w)__(?!_)([^_]+)__(?!\w)/g;  // __underline__ (not ___bold italic___)
const BOLD_ITALIC_RE = /\*\*\*[^*]+\*\*\*/g;            // ***bold italic***
const BOLD_STRIKE_RE = /\*\*~~[^~]+~~\*\*/g;            // **~~bold strikethrough~~**
const ITALIC_STRIKE_RE = /\*~~[^~]+~~\*/g;              // *~~italic strikethrough~~*
const HTML_TAG_RE = /<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g;  // <tag>, </tag>, <tag attr="v">

const deco = {
  highlight:  Decoration.mark({ attributes: { style: 'background: rgba(255, 213, 0, 0.25); border-radius: 2px; padding: 1px 0;' } }),
  mathInline: Decoration.mark({ attributes: { style: 'color: #c678dd; font-style: italic;' } }),
  diffAdd:    Decoration.mark({ attributes: { style: 'color: #4ec9b0; background: rgba(78, 201, 176, 0.1);' } }),
  diffDel:    Decoration.mark({ attributes: { style: 'color: #e06c75; background: rgba(224, 108, 117, 0.1); text-decoration: line-through;' } }),
  footnote:   Decoration.mark({ attributes: { style: 'color: #61afef; font-size: 0.85em; vertical-align: super;' } }),
  strikethrough: Decoration.mark({ attributes: { style: 'text-decoration: line-through; opacity: 0.7;' } }),
  underline:  Decoration.mark({ attributes: { style: 'text-decoration: underline;' } }),
  boldItalic: Decoration.mark({ attributes: { style: 'font-weight: bold; font-style: italic;' } }),
  boldStrike: Decoration.mark({ attributes: { style: 'font-weight: bold; text-decoration: line-through; opacity: 0.7;' } }),
  italicStrike: Decoration.mark({ attributes: { style: 'font-style: italic; text-decoration: line-through; opacity: 0.7;' } }),
  htmlTag: Decoration.mark({ attributes: { style: 'color: #e06c75;' } }),           // <tag> — red (like tag name in HTML editors)
  htmlAttr: Decoration.mark({ attributes: { style: 'color: #d19a66;' } }),           // attr= — orange
  htmlAttrValue: Decoration.mark({ attributes: { style: 'color: #98c379;' } }),      // "value" — green
  htmlBracket: Decoration.mark({ attributes: { style: 'color: #abb2bf;' } }),        // < > / — grey
};

function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  // Pre-scan frontmatter range (line 1 or 2 may be ---, line 1 can be settings comment)
  let frontmatterStart = 0;
  let frontmatterEnd = 0;
  for (let s = 1; s <= Math.min(2, doc.lines); s++) {
    if (doc.line(s).text.trim() === '---') {
      for (let j = s + 1; j <= doc.lines; j++) {
        if (doc.line(j).text.trim() === '---') {
          frontmatterStart = s;
          frontmatterEnd = j;
          break;
        }
      }
      if (frontmatterEnd > 0) break;
    }
  }

  // Callout tracking
  let activeCalloutColor: string | null = null;
  let calloutEnd = 0;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    // Collect all mark decorations for this line, sort before adding to builder
    const marks: Array<{from: number; to: number; deco: Decoration}> = [];

    // ── Frontmatter block ──
    if (frontmatterStart > 0 && i >= frontmatterStart && i <= frontmatterEnd) {
      builder.add(line.from, line.from, Decoration.line({
        attributes: { class: 'cm-frontmatter-line', style: 'background: rgba(209, 154, 102, 0.06); border-left: 3px solid rgba(209, 154, 102, 0.4); padding-left: 8px;' },
      }));
      if (i > frontmatterStart && i < frontmatterEnd) {
        const colonIdx = text.indexOf(':');
        if (colonIdx > 0) {
          marks.push({from: line.from, to: line.from + colonIdx, deco: Decoration.mark({
            attributes: { style: 'color: #e06c75; font-weight: 500; ' },
          })});
          if (colonIdx + 1 < text.length) {
            marks.push({from: line.from + colonIdx + 1, to: line.to, deco: Decoration.mark({
              attributes: { style: 'color: #98c379; ' },
            })});
          }
        } else {
          // Lines without colon (e.g. array items)
          marks.push({from: line.from, to: line.to, deco: Decoration.mark({
            attributes: { style: 'color: #98c379; ' },
          })});
        }
      } else {
        // --- delimiters
        marks.push({from: line.from, to: line.to, deco: Decoration.mark({
          attributes: { style: 'color: #d19a66; font-weight: bold; ' },
        })});
      }
      // Sort and flush marks for this line
      marks.sort((a, b) => a.from - b.from || a.to - b.to);
      for (const m of marks) builder.add(m.from, m.to, m.deco);
      continue;
    }

    // ── Callouts (line decorations) ──
    const calloutMatch = text.match(CALLOUT_RE);
    if (calloutMatch) {
      const color = CALLOUT_COLORS[calloutMatch[1].toLowerCase()] || '#61afef';
      activeCalloutColor = color;
      calloutEnd = i;
      for (let j = i + 1; j <= doc.lines; j++) {
        if (doc.line(j).text.startsWith('>')) calloutEnd = j;
        else break;
      }
      builder.add(line.from, line.from, Decoration.line({
        attributes: { style: `border-left: 3px solid ${color}; padding-left: 8px;` },
      }));
    } else if (activeCalloutColor && i <= calloutEnd && text.startsWith('>')) {
      builder.add(line.from, line.from, Decoration.line({
        attributes: { style: `border-left: 3px solid ${activeCalloutColor}; padding-left: 8px; opacity: 0.9;` },
      }));
    } else {
      activeCalloutColor = null;
    }

    // ── Table rows (line decoration) ──
    if (TABLE_RE.test(text)) {
      builder.add(line.from, line.from, Decoration.line({
        attributes: { style: 'background: rgba(255,255,255,0.03);' },
      }));
    }

    // ── Math block delimiter $$ ──
    if (MATH_BLOCK_RE.test(text.trim())) {
      marks.push({from: line.from, to: line.to, deco: Decoration.mark({
        attributes: { style: 'color: #c678dd; font-weight: bold;' },
      })});
    }

    // ── Checkbox ──
    const checkedMatch = text.match(CHECKBOX_CHECKED_RE);
    if (checkedMatch) {
      const start = line.from + checkedMatch[1].length;
      marks.push({from: start, to: start + 3, deco: Decoration.mark({
        attributes: { style: 'color: #4ec9b0; font-weight: bold;' },
      })});
    }
    const uncheckedMatch = text.match(CHECKBOX_UNCHECKED_RE);
    if (uncheckedMatch) {
      const start = line.from + uncheckedMatch[1].length;
      marks.push({from: start, to: start + 3, deco: Decoration.mark({
        attributes: { style: 'color: #7f848e;' },
      })});
    }

    // ── [[toc]] ──
    if (TOC_RE.test(text.trim())) {
      marks.push({from: line.from, to: line.to, deco: Decoration.mark({
        attributes: { style: 'color: #61afef; font-style: italic;' },
      })});
    }

    // ── HTML/XML tags ──
    HTML_TAG_RE.lastIndex = 0;
    let htmlM;
    while ((htmlM = HTML_TAG_RE.exec(text))) {
      const tagStr = htmlM[0];
      const tagStart = line.from + htmlM.index;
      const tagParts = tagStr.match(/^(<\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)(\s*\/?>)$/);
      if (tagParts) {
        let pos = tagStart;
        marks.push({from: pos, to: pos + tagParts[1].length, deco: deco.htmlBracket});
        pos += tagParts[1].length;
        marks.push({from: pos, to: pos + tagParts[2].length, deco: deco.htmlTag});
        pos += tagParts[2].length;
        if (tagParts[3].length > 0) {
          const attrRe = /(\s+)([a-zA-Z_-]+)(="[^"]*"|='[^']*')?/g;
          let attrM;
          while ((attrM = attrRe.exec(tagParts[3]))) {
            const attrStart = pos + attrM.index + attrM[1].length;
            marks.push({from: attrStart, to: attrStart + attrM[2].length, deco: deco.htmlAttr});
            if (attrM[3]) {
              const eqStart = attrStart + attrM[2].length;
              marks.push({from: eqStart, to: eqStart + 1, deco: deco.htmlBracket});
              marks.push({from: eqStart + 1, to: eqStart + attrM[3].length, deco: deco.htmlAttrValue});
            }
          }
          pos += tagParts[3].length;
        }
        marks.push({from: pos, to: pos + tagParts[4].length, deco: deco.htmlBracket});
      }
    }

    // ── Inline patterns ──
    for (const [re, d] of [
      [BOLD_ITALIC_RE, deco.boldItalic],
      [BOLD_STRIKE_RE, deco.boldStrike],
      [ITALIC_STRIKE_RE, deco.italicStrike],
      [HIGHLIGHT_RE, deco.highlight],
      [MATH_INLINE_RE, deco.mathInline],
      [DIFF_ADD_RE, deco.diffAdd],
      [DIFF_DEL_RE, deco.diffDel],
      [FOOTNOTE_RE, deco.footnote],
      [STRIKETHROUGH_RE, deco.strikethrough],
      [UNDERLINE_RE, deco.underline],
    ] as [RegExp, Decoration][]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        marks.push({from: line.from + m.index, to: line.from + m.index + m[0].length, deco: d});
      }
    }

    // Sort all mark decorations by position, then add to builder
    marks.sort((a, b) => a.from - b.from || a.to - b.to);
    for (const m of marks) builder.add(m.from, m.to, m.deco);
  }

  return builder.finish();
}

const markdownDecoPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = buildMarkdownDecorations(view);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildMarkdownDecorations(update.view);
    }
  }
}, { decorations: (v) => v.decorations });

// ─── Source search state ──────────────────────────────────────────────────────

interface SourceSearchState {
  results: Array<{ from: number; to: number }>;
  currentIndex: number;
}

const setSourceSearchEffect = StateEffect.define<SourceSearchState>();

const sourceSearchField = StateField.define<SourceSearchState>({
  create() { return { results: [], currentIndex: -1 }; },
  update(state, tr) {
    for (const e of tr.effects) {
      if (e.is(setSourceSearchEffect)) return e.value;
    }
    if (tr.docChanged && state.results.length > 0) {
      const newResults = state.results.map(r => ({
        from: tr.changes.mapPos(r.from),
        to: tr.changes.mapPos(r.to),
      })).filter(r => r.from < r.to);
      return {
        results: newResults,
        currentIndex: newResults.length > 0 ? Math.min(state.currentIndex, newResults.length - 1) : -1,
      };
    }
    return state;
  },
});

const sourceSearchDecorations = EditorView.decorations.compute([sourceSearchField], (state) => {
  const { results, currentIndex } = state.field(sourceSearchField);
  const builder = new RangeSetBuilder<Decoration>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const cls = i === currentIndex ? 'find-result current-result' : 'find-result';
    builder.add(r.from, r.to, Decoration.mark({ class: cls }));
  }
  return builder.finish();
});

function searchSourceText(
  text: string,
  query: string,
  caseSensitive: boolean,
  regexEnabled: boolean
): Array<{ from: number; to: number }> {
  if (!query) return [];
  const pattern = regexEnabled ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = caseSensitive ? 'g' : 'gi';
  let regex: RegExp;
  try { regex = new RegExp(pattern, flags); } catch { return []; }
  const results: Array<{ from: number; to: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '') break;
    results.push({ from: match.index, to: match.index + match[0].length });
  }
  return results;
}

export interface SourceEditorOptions {
  parent: HTMLElement;
  onChange: (content: string) => void;
  /** Called when native CM undo stack is exhausted — return true if cross-mode undo was handled */
  onUndoExhausted?: () => boolean;
  /** Called when native CM redo stack is exhausted — return true if cross-mode redo was handled */
  onRedoExhausted?: () => boolean;
}

export function createSourceEditor(options: SourceEditorOptions) {
  let suppressChange = false;

  const onChangeExtension = EditorView.updateListener.of((update) => {
    if (update.docChanged && !suppressChange) {
      options.onChange(update.state.doc.toString());
    }
  });

  const view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        bracketMatching(),
        closeBrackets(),
        markdown({ codeLanguages: languages }),
        syntaxHighlighting(vscodeHighlightStyle),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        // Cross-mode undo/redo fallback — runs when native history stack is exhausted
        keymap.of([
          { key: 'Mod-z', run: () => options.onUndoExhausted?.() ?? false },
          { key: 'Mod-y', run: () => options.onRedoExhausted?.() ?? false },
          { key: 'Mod-Shift-z', run: () => options.onRedoExhausted?.() ?? false },
        ]),
        vscodeTheme,
        markdownDecoPlugin,
        sourceSearchField,
        sourceSearchDecorations,
        EditorView.lineWrapping,
        onChangeExtension,
      ],
    }),
    parent: options.parent,
  });

  return {
    view,
    getContent: () => view.state.doc.toString(),
    setContent: (text: string) => {
      suppressChange = true;
      const cursor = view.state.selection.main.head;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: Math.min(cursor, text.length) },
        annotations: Transaction.addToHistory.of(false),
      });
      suppressChange = false;
    },
    replaceFirstLine: (newLine: string) => {
      suppressChange = true;
      const firstLine = view.state.doc.line(1);
      view.dispatch({
        changes: { from: firstLine.from, to: firstLine.to, insert: newLine },
        annotations: Transaction.addToHistory.of(false),
      });
      suppressChange = false;
    },
    scrollToLine: (line: number) => {
      const cmLine = view.state.doc.line(line);
      view.dispatch({
        selection: { anchor: cmLine.from },
        effects: EditorView.scrollIntoView(cmLine.from, { y: 'start', yMargin: 40 }),
      });
    },
    getTopLineNumber: () => {
      const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      return view.state.doc.lineAt(block.from).number;
    },
    getLineTopOffset: (line: number) => {
      try {
        const cmLine = view.state.doc.line(line);
        const block = view.lineBlockAt(cmLine.from);
        return block.top - view.scrollDOM.scrollTop;
      } catch {
        return -1;
      }
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),

    // ── Search API ──
    search(query: string, caseSensitive: boolean, regexEnabled: boolean) {
      const text = view.state.doc.toString();
      const results = searchSourceText(text, query, caseSensitive, regexEnabled);
      view.dispatch({ effects: setSourceSearchEffect.of({ results, currentIndex: results.length > 0 ? 0 : -1 }) });
      return { results, currentIndex: results.length > 0 ? 0 : -1 };
    },
    getSearchState(): SourceSearchState {
      return view.state.field(sourceSearchField);
    },
    goToMatch(index: number) {
      const state = view.state.field(sourceSearchField);
      if (index < 0 || index >= state.results.length) return;
      const r = state.results[index];
      view.dispatch({
        effects: setSourceSearchEffect.of({ ...state, currentIndex: index }),
        selection: { anchor: r.from, head: r.to },
        scrollIntoView: true,
      });
    },
    nextMatch() {
      const state = view.state.field(sourceSearchField);
      if (state.results.length === 0) return;
      const next = (state.currentIndex + 1) % state.results.length;
      this.goToMatch(next);
    },
    prevMatch() {
      const state = view.state.field(sourceSearchField);
      if (state.results.length === 0) return;
      const prev = state.currentIndex - 1 < 0 ? state.results.length - 1 : state.currentIndex - 1;
      this.goToMatch(prev);
    },
    replaceCurrent(replaceText: string) {
      const state = view.state.field(sourceSearchField);
      if (state.currentIndex < 0 || state.currentIndex >= state.results.length) return;
      const r = state.results[state.currentIndex];
      view.dispatch({ changes: { from: r.from, to: r.to, insert: replaceText } });
    },
    replaceAllMatches(replaceText: string) {
      const state = view.state.field(sourceSearchField);
      if (state.results.length === 0) return;
      const changes = [...state.results].reverse().map(r => ({ from: r.from, to: r.to, insert: replaceText }));
      view.dispatch({ changes });
    },
    clearSearch() {
      view.dispatch({ effects: setSourceSearchEffect.of({ results: [], currentIndex: -1 }) });
    },
  };
}
