/**
 * List node specs for the InLineMd ProseMirror schema.
 */

import type { NodeSpec } from 'prosemirror-model';

const bullet_list: NodeSpec = {
  content: 'list_item+',
  group: 'block list',
  parseDOM: [{ tag: 'ul' }],
  toDOM() {
    return ['ul', 0];
  },
};

const ordered_list: NodeSpec = {
  attrs: {
    order: { default: 1, validate: 'number' },
  },
  content: 'list_item+',
  group: 'block list',
  parseDOM: [
    {
      tag: 'ol',
      getAttrs(dom: HTMLOListElement) {
        return { order: dom.hasAttribute('start') ? +dom.getAttribute('start')! : 1 };
      },
    },
  ],
  toDOM(node) {
    return node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order }, 0];
  },
};

const list_item: NodeSpec = {
  attrs: {},
  content: 'block+',
  defining: true,
  parseDOM: [{ tag: 'li:not([data-type])' }],
  toDOM() {
    return ['li', ['div', { class: 'list-item-content' }, 0]];
  },
};

const checkbox_list: NodeSpec = {
  content: 'checkbox_item+',
  group: 'block list',
  parseDOM: [
    { tag: 'ul.checkbox-list' },
    // Standard HTML: <ul> containing <li> with <input type="checkbox">
    {
      tag: 'ul',
      // Higher priority than bullet_list to match first
      priority: 60,
      getAttrs(dom: HTMLUListElement) {
        // Only match if at least one <li> has an <input type="checkbox">
        const items = dom.querySelectorAll(':scope > li');
        for (const li of items) {
          if (li.querySelector(':scope > input[type="checkbox"]')) return {};
        }
        return false;
      },
    },
  ],
  toDOM() {
    return ['ul', { class: 'checkbox-list' }, 0];
  },
};

const checkbox_item: NodeSpec = {
  attrs: {
    checked: { default: false }, // false | true | 'inapplicable'
  },
  content: 'block+',
  defining: true,
  parseDOM: [
    {
      tag: 'li[data-type="checkbox_item"]',
      getAttrs(dom: HTMLLIElement) {
        const val = dom.dataset.checked;
        if (val === 'inapplicable') return { checked: 'inapplicable' };
        return { checked: val === 'true' };
      },
    },
    // Standard HTML: <li> with <input type="checkbox">
    {
      tag: 'li',
      priority: 60,
      getAttrs(dom: HTMLLIElement) {
        const checkbox = dom.querySelector(':scope > input[type="checkbox"]');
        if (!checkbox) return false;
        return { checked: (checkbox as HTMLInputElement).checked || checkbox.hasAttribute('checked') };
      },
    },
  ],
  toDOM(node) {
    const checked = node.attrs.checked;
    const cls = checked === 'inapplicable' ? 'inapplicable' : checked ? 'checked' : '';
    return [
      'li',
      {
        'data-type': 'checkbox_item',
        'data-checked': String(checked),
        class: cls,
      },
      ['span', { class: 'checkbox', contenteditable: 'false' }],
      ['div', { class: 'checkbox-content' }, 0],
    ];
  },
};

export const listNodes: Record<string, NodeSpec> = {
  bullet_list,
  ordered_list,
  list_item,
  checkbox_list,
  checkbox_item,
};
