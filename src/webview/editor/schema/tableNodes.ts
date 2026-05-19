/**
 * Table node specs for the InLineMd ProseMirror schema.
 */

import type { NodeSpec } from 'prosemirror-model';

// Table nodes
const table: NodeSpec = {
  content: 'table_row+',
  group: 'block',
  isolating: true,
  tableRole: 'table',
  parseDOM: [{ tag: 'table' }],
  toDOM() {
    return ['div', { class: 'table-wrapper' }, ['table', ['tbody', 0]]];
  },
};

const table_row: NodeSpec = {
  content: '(table_cell | table_header)*',
  tableRole: 'row',
  parseDOM: [{ tag: 'tr' }],
  toDOM() {
    return ['tr', 0];
  },
};

const table_cell: NodeSpec = {
  attrs: {
    colspan: { default: 1, validate: 'number' },
    rowspan: { default: 1, validate: 'number' },
    alignment: { default: null },
  },
  content: 'block+',
  tableRole: 'cell',
  isolating: true,
  parseDOM: [
    {
      tag: 'td',
      getAttrs(dom: HTMLTableCellElement) {
        return {
          colspan: dom.colSpan,
          rowspan: dom.rowSpan,
          alignment: dom.style.textAlign || null,
        };
      },
    },
  ],
  toDOM(node) {
    const attrs: Record<string, any> = {};
    if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
    if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
    if (node.attrs.alignment) attrs.style = `text-align: ${node.attrs.alignment}`;
    return ['td', attrs, 0];
  },
};

const table_header: NodeSpec = {
  attrs: {
    colspan: { default: 1, validate: 'number' },
    rowspan: { default: 1, validate: 'number' },
    alignment: { default: null },
  },
  content: 'block+',
  tableRole: 'header_cell',
  isolating: true,
  parseDOM: [
    {
      tag: 'th',
      getAttrs(dom: HTMLTableCellElement) {
        return {
          colspan: dom.colSpan,
          rowspan: dom.rowSpan,
          alignment: dom.style.textAlign || null,
        };
      },
    },
  ],
  toDOM(node) {
    const attrs: Record<string, any> = {};
    if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
    if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
    if (node.attrs.alignment) attrs.style = `text-align: ${node.attrs.alignment}`;
    return ['th', attrs, 0];
  },
};

export const tableNodes: Record<string, NodeSpec> = {
  table,
  table_row,
  table_cell,
  table_header,
};
