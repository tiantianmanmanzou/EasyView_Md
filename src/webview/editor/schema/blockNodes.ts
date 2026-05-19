/**
 * Block node specs for the InLineMd ProseMirror schema.
 */

import type { NodeSpec } from 'prosemirror-model';

const doc: NodeSpec = {
  content: 'frontmatter? block+',
};

const frontmatter: NodeSpec = {
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  isolating: true,
  atom: true,
  parseDOM: [
    {
      tag: 'pre.frontmatter',
      preserveWhitespace: 'full' as const,
    },
  ],
  toDOM() {
    return [
      'pre',
      { class: 'frontmatter' },
      ['code', 0],
    ];
  },
};

const paragraph: NodeSpec = {
  content: 'inline*',
  group: 'block',
  parseDOM: [{ tag: 'p' }],
  toDOM() {
    return ['p', 0];
  },
};

const heading: NodeSpec = {
  attrs: {
    level: { default: 1, validate: 'number' },
    collapsed: { default: undefined },
  },
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [
    { tag: 'h1', attrs: { level: 1 } },
    { tag: 'h2', attrs: { level: 2 } },
    { tag: 'h3', attrs: { level: 3 } },
    { tag: 'h4', attrs: { level: 4 } },
    { tag: 'h5', attrs: { level: 5 } },
    { tag: 'h6', attrs: { level: 6 } },
  ],
  toDOM(node) {
    return [
      `h${node.attrs.level}`,
      { class: 'heading-content', dir: 'auto' },
      0
    ];
  },
};

const blockquote: NodeSpec = {
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'blockquote' }],
  toDOM() {
    return ['blockquote', 0];
  },
};

const horizontal_rule: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  parseDOM: [{ tag: 'hr' }],
  toDOM() {
    return ['hr'];
  },
};

const code_block: NodeSpec = {
  attrs: {
    language: { default: '', validate: 'string' },
  },
  content: 'text*',
  marks: '',
  group: 'block',
  code: true,
  defining: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'pre',
      preserveWhitespace: 'full' as const,
      getAttrs(dom: HTMLPreElement) {
        const code = dom.querySelector('code');
        const className = code?.className || '';
        const match = className.match(/language-(\w+)/);
        return { language: match ? match[1] : '' };
      },
    },
  ],
  toDOM(node) {
    return [
      'pre',
      { class: `code-block${node.attrs.language ? ` language-${node.attrs.language}` : ''}` },
      ['code', { class: node.attrs.language ? `language-${node.attrs.language}` : '' }, 0],
    ];
  },
};

const notice: NodeSpec = {
  attrs: {
    style: { default: 'note', validate: 'string' },
  },
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [
    {
      tag: 'div.notice-block',
      getAttrs(dom: HTMLDivElement) {
        return { style: dom.dataset.style || 'note' };
      },
    },
    // Standard HTML: <blockquote> with first child <p>[!type]</p>
    {
      tag: 'blockquote',
      priority: 60,
      getAttrs(dom: HTMLQuoteElement) {
        const firstP = dom.querySelector(':scope > p:first-child');
        if (!firstP) return false;
        const match = firstP.textContent?.match(/^\[!(\w+)\]$/);
        if (!match) return false;
        return { style: match[1].toLowerCase() };
      },
    },
  ],
  toDOM(node) {
    return [
      'div',
      { class: `notice-block notice-${node.attrs.style}`, 'data-style': node.attrs.style },
      0,
    ];
  },
};

// Collapsible details block (<details>/<summary>)
const details: NodeSpec = {
  attrs: {
    summary: { default: 'Details' },
  },
  content: 'block+',
  group: 'block',
  defining: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'details',
      getAttrs(dom: HTMLDetailsElement) {
        const summaryEl = dom.querySelector('summary');
        return { summary: summaryEl?.textContent || 'Details' };
      },
    },
    {
      tag: 'div.details-block',
      getAttrs(dom: HTMLDivElement) {
        const summaryEl = dom.querySelector('.details-summary-text');
        return { summary: summaryEl?.textContent || 'Details' };
      },
    },
  ],
  toDOM(node) {
    return [
      'div',
      { class: 'details-block details-collapsed' },
      ['div', { class: 'details-summary', contenteditable: 'false' },
        ['span', { class: 'details-arrow' }],
        ['span', { class: 'details-summary-text' }, node.attrs.summary],
      ],
      ['div', { class: 'details-content' }, 0],
    ];
  },
};

// HTML block — preserves raw HTML that can't be represented as markdown
const html_block: NodeSpec = {
  attrs: {
    html: { default: '' },
  },
  group: 'block',
  atom: true,
  selectable: true,
  defining: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'div[data-type="html_block"]',
      getAttrs(dom: HTMLDivElement) {
        return { html: dom.getAttribute('data-html') || dom.textContent || '' };
      },
    },
  ],
  toDOM(node) {
    return [
      'div',
      {
        'data-type': 'html_block',
        'data-html': node.attrs.html,
        class: 'html-block',
        contenteditable: 'false',
      },
      ['div', { class: 'html-block-label' }, 'HTML'],
      ['pre', { class: 'html-block-code' }, node.attrs.html],
    ];
  },
};

// Description list nodes — dl/dt/dd
const description_list: NodeSpec = {
  content: '(description_term | description_detail)+',
  group: 'block',
  parseDOM: [{ tag: 'dl' }],
  toDOM() {
    return ['dl', { class: 'description-list' }, 0];
  },
};

const description_term: NodeSpec = {
  content: 'inline*',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dt' }],
  toDOM() {
    return ['dt', 0];
  },
};

const description_detail: NodeSpec = {
  content: 'block+',
  group: 'block',
  defining: true,
  parseDOM: [{ tag: 'dd' }],
  toDOM() {
    return ['dd', 0];
  },
};

// Footnote definition — [^label]: content
const footnote_def: NodeSpec = {
  content: 'block+',
  group: 'block',
  attrs: {
    label: { default: '' },
  },
  defining: true,
  isolating: true,
  parseDOM: [
    {
      tag: 'div.footnote-def',
      getAttrs(dom: HTMLElement) {
        return { label: dom.dataset.label || '' };
      },
    },
  ],
  toDOM(node) {
    return [
      'div',
      { class: 'footnote-def', 'data-label': node.attrs.label },
      ['span', { class: 'footnote-label', contenteditable: 'false' }, `[^${node.attrs.label}]:`],
      ['div', { class: 'footnote-content' }, 0],
    ];
  },
};

// Table of Contents — [[_TOC_]] placeholder node
const table_of_contents: NodeSpec = {
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  parseDOM: [{ tag: 'div.toc-block' }],
  toDOM() {
    return ['div', { class: 'toc-block', contenteditable: 'false' }, 'Table of Contents'];
  },
};

export const blockNodes: Record<string, NodeSpec> = {
  doc,
  frontmatter,
  paragraph,
  heading,
  blockquote,
  horizontal_rule,
  code_block,
  notice,
  details,
  html_block,
  description_list,
  description_term,
  description_detail,
  footnote_def,
  table_of_contents,
};
