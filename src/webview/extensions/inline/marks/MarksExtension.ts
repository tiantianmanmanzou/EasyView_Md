/**
 * MarksExtension
 *
 * All inline formatting marks: strong, em, underline, strikethrough,
 * code_inline, highlight, link, html_tag.
 *
 * Includes keymaps (Mod-b/i/u/d/e/Shift-h/k) and mark input rules.
 */

import { InputRule } from 'prosemirror-inputrules';
import { toggleMark } from 'prosemirror-commands';
import type { MarkSpec, Schema, MarkType } from 'prosemirror-model';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import {
  Extension,
  type SerializerMarkHandler,
} from '../../../editor/EditorExtension';

// ─── Mark Input Rule helper ─────────────────────────────────────────────────

function markInputRule(regexp: RegExp, markType: MarkType): InputRule {
  return new InputRule(regexp, (state: EditorState, match: RegExpMatchArray, start: number, end: number) => {
    const tr = state.tr;
    if (match[1]) {
      const textStart = start + match[0].indexOf(match[1]);
      const textEnd = textStart + match[1].length;
      if (textEnd < end) tr.delete(textEnd, end);
      if (textStart > start) tr.delete(start, textStart);
      const markStart = start;
      const markEnd = markStart + match[1].length;
      tr.addMark(markStart, markEnd, markType.create());
      tr.removeStoredMark(markType);
    }
    return tr;
  });
}

// ─── Extension ──────────────────────────────────────────────────────────────

export class MarksExtension extends Extension {
  get name() {
    return 'marks';
  }

  get marks(): Record<string, MarkSpec> {
    return {
      strong: {
        parseDOM: [
          { tag: 'strong' },
          { tag: 'b', getAttrs: (dom: HTMLElement) => dom.style.fontWeight !== 'normal' && null },
          {
            style: 'font-weight',
            getAttrs: (value: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null,
          },
        ],
        toDOM() {
          return ['strong', 0];
        },
      },
      em: {
        parseDOM: [
          { tag: 'i' },
          { tag: 'em' },
          { style: 'font-style=italic' },
        ],
        toDOM() {
          return ['em', 0];
        },
      },
      underline: {
        parseDOM: [
          { tag: 'u' },
          { style: 'text-decoration=underline' },
        ],
        toDOM() {
          return ['u', 0];
        },
      },
      strikethrough: {
        parseDOM: [
          { tag: 's' },
          { tag: 'del' },
          { tag: 'strike' },
          { style: 'text-decoration=line-through' },
        ],
        toDOM() {
          return ['del', 0];
        },
      },
      code_inline: {
        parseDOM: [{ tag: 'code' }],
        toDOM() {
          return ['code', { class: 'inline-code', spellcheck: 'false' }, 0];
        },
      },
      highlight: {
        attrs: { color: { default: null } },
        parseDOM: [
          {
            tag: 'mark',
            getAttrs(dom: HTMLElement) {
              return { color: dom.dataset.color || null };
            },
          },
        ],
        toDOM(mark) {
          const color = mark.attrs.color;
          return [
            'mark',
            {
              ...(color ? { 'data-color': color, style: `background-color: ${color}40` } : {}),
            },
            0,
          ];
        },
      },
      link: {
        attrs: {
          href: { default: '', validate: 'string' },
          title: { default: null },
        },
        inclusive: false,
        parseDOM: [
          {
            tag: 'a[href]',
            getAttrs(dom: HTMLAnchorElement) {
              return {
                href: dom.getAttribute('href'),
                title: dom.getAttribute('title'),
              };
            },
          },
        ],
        toDOM(mark) {
          return [
            'a',
            {
              href: mark.attrs.href,
              title: mark.attrs.title,
              rel: 'noopener noreferrer nofollow',
              class: 'editor-link',
            },
            0,
          ];
        },
      },
      html_tag: {
        attrs: {
          tag: { default: 'span' },
          markup: { default: null },
        },
        excludes: '',
        parseDOM: [
          { tag: 'kbd', getAttrs: () => ({ tag: 'kbd' }) },
          { tag: 'sub', getAttrs: () => ({ tag: 'sub' }) },
          { tag: 'sup', getAttrs: () => ({ tag: 'sup' }) },
          { tag: 'abbr', getAttrs: () => ({ tag: 'abbr' }) },
          { tag: 'var', getAttrs: () => ({ tag: 'var' }) },
          { tag: 'samp', getAttrs: () => ({ tag: 'samp' }) },
          { tag: 'small', getAttrs: () => ({ tag: 'small' }) },
          { tag: 'ruby', getAttrs: () => ({ tag: 'ruby' }) },
          { tag: 'rt', getAttrs: () => ({ tag: 'rt' }) },
          { tag: 'rp', getAttrs: () => ({ tag: 'rp' }) },
        ],
        toDOM(mark) {
          return [mark.attrs.tag, 0];
        },
      },
    };
  }

  keymaps(schema: Schema): Record<string, Command> {
    return {
      'Mod-b': toggleMark(schema.marks.strong),
      'Mod-i': toggleMark(schema.marks.em),
      'Mod-u': toggleMark(schema.marks.underline),
      'Mod-d': toggleMark(schema.marks.strikethrough),
      'Mod-e': toggleMark(schema.marks.code_inline),
      'Mod-Shift-h': toggleMark(schema.marks.highlight),
    };
  }

  inputRules(schema: Schema): InputRule[] {
    return [
      markInputRule(/\*\*([^*]+)\*\*$/, schema.marks.strong),
      markInputRule(/(?<!\*)\*([^*]+)\*$/, schema.marks.em),
      markInputRule(/~~([^~]+)~~$/, schema.marks.strikethrough),
      markInputRule(/`([^`]+)`$/, schema.marks.code_inline),
      markInputRule(/==([^=]+)==$/, schema.marks.highlight),
    ];
  }

  get serializerMarks(): Record<string, SerializerMarkHandler> {
    return {
      strong: {
        open: '**',
        close: '**',
        mixable: true,
        expelEnclosingWhitespace: true,
      },
      em: {
        open: '*',
        close: '*',
        mixable: true,
        expelEnclosingWhitespace: true,
      },
      underline: {
        open: '__',
        close: '__',
        mixable: true,
        expelEnclosingWhitespace: true,
      },
      strikethrough: {
        open: '~~',
        close: '~~',
        mixable: true,
        expelEnclosingWhitespace: true,
      },
      code_inline: {
        open(_state, _mark, parent, index) {
          if (index >= parent.childCount) return '`';
          const content = parent.child(index).text || '';
          const backtickCount =
            Math.max(
              ...(content.match(/`+/g) || ['']).map((s: string) => s.length)
            ) + 1;
          const ticks = '`'.repeat(Math.max(1, backtickCount));
          return content.startsWith('`') ? ticks + ' ' : ticks;
        },
        close(_state, _mark, parent, index) {
          if (index >= parent.childCount) return '`';
          const content = parent.child(index).text || '';
          const backtickCount =
            Math.max(
              ...(content.match(/`+/g) || ['']).map((s: string) => s.length)
            ) + 1;
          const ticks = '`'.repeat(Math.max(1, backtickCount));
          return content.endsWith('`') ? ' ' + ticks : ticks;
        },
        escape: false,
      },
      highlight: {
        open: '==',
        close: '==',
        mixable: true,
        expelEnclosingWhitespace: true,
      },
      link: {
        open() {
          return '[';
        },
        close(state, mark) {
          const href = mark.attrs.href || '';
          const title = mark.attrs.title
            ? ` "${state.esc(mark.attrs.title)}"`
            : '';
          const formattedHref = /[\s()]/.test(href) ? `<${href}>` : href;
          return `](${formattedHref}${title})`;
        },
      },
      html_tag: {
        open(_state, mark) {
          return mark.attrs.markup || `<${mark.attrs.tag}>`;
        },
        close(_state, mark) {
          return `</${mark.attrs.tag}>`;
        },
      },
    };
  }
}
