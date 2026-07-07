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
    colwidth: { default: null },
    alignment: { default: null },
    verticalAlignment: { default: null },
  },
  content: 'block+',
  tableRole: 'cell',
  isolating: true,
  parseDOM: [
    {
      tag: 'td',
      getAttrs(dom: HTMLTableCellElement) {
        const widthAttr = dom.getAttribute('data-colwidth');
        const widths = widthAttr && /^\d+(,\d+)*$/.test(widthAttr)
          ? widthAttr.split(',').map((s) => Number(s))
          : null;
        return {
          colspan: dom.colSpan,
          rowspan: dom.rowSpan,
          colwidth: widths && widths.length === dom.colSpan ? widths : null,
          alignment: dom.style.textAlign || null,
          verticalAlignment: dom.style.verticalAlign || null,
        };
      },
    },
  ],
  toDOM(node) {
    const attrs: Record<string, any> = {};
    if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
    if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
    if (node.attrs.colwidth) attrs['data-colwidth'] = node.attrs.colwidth.join(',');
    const styles: string[] = [];
    if (node.attrs.alignment) styles.push(`text-align: ${node.attrs.alignment}`);
    if (node.attrs.verticalAlignment) styles.push(`vertical-align: ${node.attrs.verticalAlignment}`);
    if (styles.length) attrs.style = styles.join('; ');
    return ['td', attrs, 0];
  },
};

const table_header: NodeSpec = {
  attrs: {
    colspan: { default: 1, validate: 'number' },
    rowspan: { default: 1, validate: 'number' },
    colwidth: { default: null },
    alignment: { default: null },
    verticalAlignment: { default: null },
  },
  content: 'block+',
  tableRole: 'header_cell',
  isolating: true,
  parseDOM: [
    {
      tag: 'th',
      getAttrs(dom: HTMLTableCellElement) {
        const widthAttr = dom.getAttribute('data-colwidth');
        const widths = widthAttr && /^\d+(,\d+)*$/.test(widthAttr)
          ? widthAttr.split(',').map((s) => Number(s))
          : null;
        return {
          colspan: dom.colSpan,
          rowspan: dom.rowSpan,
          colwidth: widths && widths.length === dom.colSpan ? widths : null,
          alignment: dom.style.textAlign || null,
          verticalAlignment: dom.style.verticalAlign || null,
        };
      },
    },
  ],
  toDOM(node) {
    const attrs: Record<string, any> = {};
    if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
    if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
    if (node.attrs.colwidth) attrs['data-colwidth'] = node.attrs.colwidth.join(',');
    const styles: string[] = [];
    if (node.attrs.alignment) styles.push(`text-align: ${node.attrs.alignment}`);
    if (node.attrs.verticalAlignment) styles.push(`vertical-align: ${node.attrs.verticalAlignment}`);
    if (styles.length) attrs.style = styles.join('; ');
    return ['th', attrs, 0];
  },
};

export const tableNodes: Record<string, NodeSpec> = {
  table,
  table_row,
  table_cell,
  table_header,
};
