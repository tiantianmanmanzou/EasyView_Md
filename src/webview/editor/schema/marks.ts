/**
 * Mark specs for the InLineMd ProseMirror schema.
 */

import type { MarkSpec } from 'prosemirror-model';

const strong: MarkSpec = {
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
};

const em: MarkSpec = {
  parseDOM: [
    { tag: 'i' },
    { tag: 'em' },
    { style: 'font-style=italic' },
  ],
  toDOM() {
    return ['em', 0];
  },
};

const underline: MarkSpec = {
  parseDOM: [
    { tag: 'u' },
    { style: 'text-decoration=underline' },
  ],
  toDOM() {
    return ['u', 0];
  },
};

const strikethrough: MarkSpec = {
  parseDOM: [
    { tag: 's' },
    { tag: 'del', getAttrs: (dom: HTMLElement) => !(dom as HTMLElement).classList?.contains('diff-del') && null },
    { tag: 'strike' },
    { style: 'text-decoration=line-through' },
  ],
  toDOM() {
    return ['del', 0];
  },
};

const code_inline: MarkSpec = {
  parseDOM: [{ tag: 'code' }],
  toDOM() {
    return ['code', { class: 'inline-code', spellcheck: 'false' }, 0];
  },
};

const highlight: MarkSpec = {
  attrs: {
    color: { default: null },
  },
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
};

const link: MarkSpec = {
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
};

// Inline diff marks — GitLab syntax: {+ added +} / {- removed -}
const diff_add: MarkSpec = {
  parseDOM: [
    { tag: 'ins.diff-add' },
    { tag: 'span.diff-add' },
  ],
  toDOM() {
    return ['ins', { class: 'diff-add' }, 0];
  },
};

const diff_del: MarkSpec = {
  parseDOM: [
    { tag: 'del.diff-del' },
    { tag: 'span.diff-del' },
  ],
  toDOM() {
    return ['del', { class: 'diff-del' }, 0];
  },
};

// Generic mark for known inline HTML tags (kbd, sub, sup, etc.)
const html_tag: MarkSpec = {
  attrs: {
    tag: { default: 'span' },
    markup: { default: null }, // Original opening tag markup for round-trip
  },
  excludes: '', // Allow multiple html_tag marks to coexist
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
};

export const marks: Record<string, MarkSpec> = {
  strong,
  em,
  underline,
  diff_add,
  diff_del,
  strikethrough,
  code_inline,
  highlight,
  link,
  html_tag,
};
