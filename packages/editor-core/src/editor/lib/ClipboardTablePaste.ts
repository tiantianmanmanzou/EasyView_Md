/**
 * Parse spreadsheet clipboard payloads (Excel / Sheets HTML or TSV)
 * into a ProseMirror table node for nesting inside a table cell.
 */

import {
  DOMParser as PmDOMParser,
  Fragment,
  Slice,
  type Node as ProsemirrorNode,
  type ResolvedPos,
  type Schema,
} from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { CellSelection } from 'prosemirror-tables';
import type { EditorView } from 'prosemirror-view';
import {
  getSelectionAnchorElement,
  preserveScrollAround,
} from './ScrollPreserve';

export function isInsideTableCell($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') return true;
  }
  return false;
}

export function looksLikeSpreadsheetTsv(text: string): boolean {
  const lines = normalizeSpreadsheetLines(text);
  if (lines.length === 0) return false;
  if (lines.length === 1) return lines[0].includes('\t');
  const tabLines = lines.filter((line) => line.includes('\t')).length;
  return tabLines >= 1 && tabLines >= Math.ceil(lines.length / 2);
}

export function isInternalEditorClipboard(html?: string): boolean {
  return Boolean(html && (html.includes('ProseMirror') || html.includes('data-pm-slice')));
}

function isCellWrapperHtmlTable(tableEl: HTMLTableElement): boolean {
  return tableEl.rows.length === 1 && tableEl.rows[0].cells.length === 1;
}

function isCellWrapperTableNode(table: ProsemirrorNode): boolean {
  if (table.type.name !== 'table' || table.childCount !== 1) return false;
  const row = table.firstChild;
  if (!row || row.childCount !== 1) return false;
  const cell = row.firstChild;
  return Boolean(cell && (cell.type.name === 'table_cell' || cell.type.name === 'table_header'));
}

/** A 1×1 table copied via CellSelection is a cell wrapper, not nested table data. */
export function unwrapCellWrapperTableFragment(fragment: Fragment): Fragment {
  if (fragment.childCount !== 1) return fragment;
  const first = fragment.firstChild;
  if (!first || !isCellWrapperTableNode(first)) return fragment;
  const cell = first.firstChild!.firstChild!;
  return cell.content;
}

export function unwrapCellWrapperTablesInClipboardHtml(html: string): string {
  if (!/<table[\s>]/i.test(html)) return html;
  const document = new DOMParser().parseFromString(html, 'text/html');
  const tableEl = pickClipboardTableElement(document);
  if (!tableEl || !isCellWrapperHtmlTable(tableEl)) return html;
  if (!tableEl.hasAttribute('data-easyview-cell-copy')) return html;

  const cell = tableEl.rows[0].cells[0];
  const contentEl = cell.querySelector('.easyview-table-cell-content');
  if (!contentEl) return html;
  const wrapper = document.createElement('div');
  wrapper.innerHTML = contentEl.innerHTML;
  return wrapper.innerHTML;
}

/**
 * Spreadsheet / external table payloads should become nested tables on cell paste.
 * Internal editor copies only nest when the clipboard carries real table data
 * (multi-cell grid or an explicit nested table), not a 1×1 cell wrapper.
 */
export function shouldPasteClipboardAsNestedTable(
  html: string | undefined,
  text: string | undefined,
  schema: Schema,
): boolean {
  const isInternal = isInternalEditorClipboard(html);

  if (text && looksLikeSpreadsheetTsv(text)) {
    return !isInternal;
  }

  if (!html || !/<table[\s>]/i.test(html)) return false;
  if (!isInternal) {
    return parseHtmlTable(html, schema) != null;
  }

  const document = new DOMParser().parseFromString(html, 'text/html');
  const tableEl = pickClipboardTableElement(document);
  if (!tableEl) return false;
  if (!isCellWrapperHtmlTable(tableEl)) return true;

  const cell = tableEl.rows[0].cells[0];
  const contentRoot = cell.querySelector('.easyview-table-cell-content') ?? cell;
  const blockChildren = Array.from(contentRoot.children);
  const tableBlocks = blockChildren.filter((element) =>
    element.classList.contains('table-wrapper') || element.tagName === 'TABLE'
  );
  return tableBlocks.length > 0 && tableBlocks.length === blockChildren.length;
}

export function parseClipboardAsNestedTable(
  html: string | undefined,
  text: string | undefined,
  schema: Schema
): ProsemirrorNode | null {
  if (html && /<table[\s>]/i.test(html)) {
    const fromHtml = parseHtmlTable(html, schema);
    if (fromHtml) return fromHtml;
  }
  if (text && looksLikeSpreadsheetTsv(text)) {
    return parseTsvTable(text, schema);
  }
  return null;
}

/** Expand rowspan/colspan in external clipboard HTML so pasted tables stay unmerged. */
export function unmergeTablesInClipboardHtml(html: string): string {
  if (!/<table[\s>]/i.test(html) || !/(?:row|col)span\s*=/i.test(html)) return html;
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const table of Array.from(document.querySelectorAll('table'))) {
    expandMergedHtmlCells(table as HTMLTableElement);
  }
  return document.body.innerHTML;
}

export function flattenMergedTablesInFragment(fragment: Fragment): Fragment {
  const children: ProsemirrorNode[] = [];
  fragment.forEach((child) => {
    children.push(flattenMergedTablesInNode(child));
  });
  return Fragment.from(children);
}

export function insertNestedTableInCell(view: EditorView, table: ProsemirrorNode): boolean {
  const { state } = view;
  const { selection } = state;
  const anchor = getSelectionAnchorElement(view);
  let inserted = false;

  preserveScrollAround(anchor, () => {
    // Single-cell CellSelection: replace that cell's content with the nested table.
    if (selection instanceof CellSelection) {
      if (selection.$anchorCell.pos !== selection.$headCell.pos) return;
      const cell = selection.$anchorCell.nodeAfter;
      if (!cell) return;
      const from = selection.$anchorCell.pos + 1;
      const to = selection.$anchorCell.pos + cell.nodeSize - 1;
      const tr = state.tr.replaceWith(from, to, table);
      const $pos = tr.doc.resolve(Math.min(from + 1, tr.doc.content.size));
      tr.setSelection(TextSelection.near($pos));
      view.dispatch(tr);
      inserted = true;
      return;
    }

    const { $from } = selection;

    let cellDepth = -1;
    for (let depth = $from.depth; depth > 0; depth--) {
      const role = $from.node(depth).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') {
        cellDepth = depth;
        break;
      }
    }
    if (cellDepth < 0) return;

    const cell = $from.node(cellDepth);
    const cellStart = $from.start(cellDepth);
    const cellEnd = $from.end(cellDepth);

    // Empty cell → replace its placeholder paragraph with the nested table.
    if (
      selection.empty &&
      cell.childCount === 1 &&
      cell.firstChild?.type.name === 'paragraph' &&
      cell.firstChild.content.size === 0
    ) {
      view.dispatch(state.tr.replaceWith(cellStart, cellEnd, table));
      inserted = true;
      return;
    }

    view.dispatch(state.tr.replaceSelection(new Slice(Fragment.from(table), 0, 0)));
    inserted = true;
  });

  return inserted;
}

export function parseHtmlTable(html: string, schema: Schema): ProsemirrorNode | null {
  const domParser = new DOMParser();
  const document = domParser.parseFromString(html, 'text/html');
  const tableEl = pickClipboardTableElement(document);
  if (!tableEl) return null;

  expandMergedHtmlCells(tableEl);

  const wrapper = document.createElement('div');
  wrapper.appendChild(tableEl.cloneNode(true));
  const parsed = PmDOMParser.fromSchema(schema).parse(wrapper);
  const table = findFirstTable(parsed);
  return table ? flattenMergedTableNode(table) : null;
}

export function parseTsvTable(text: string, schema: Schema): ProsemirrorNode | null {
  const lines = normalizeSpreadsheetLines(text);
  if (lines.length === 0) return null;

  const rows = lines.map((line) => line.split('\t'));
  const colCount = Math.max(1, ...rows.map((row) => row.length));
  const paragraph = schema.nodes.paragraph;
  const tableCell = schema.nodes.table_cell;
  const tableHeader = schema.nodes.table_header;
  const tableRow = schema.nodes.table_row;
  const table = schema.nodes.table;

  const rowNodes = rows.map((cells, rowIndex) => {
    const cellType = rowIndex === 0 ? tableHeader : tableCell;
    const cellNodes = Array.from({ length: colCount }, (_, colIndex) => {
      const value = (cells[colIndex] ?? '').replace(/\u00a0/g, ' ');
      const content = value ? schema.text(value) : undefined;
      return cellType.create(null, paragraph.create(null, content));
    });
    return tableRow.create(null, cellNodes);
  });

  return flattenMergedTableNode(table.create(null, rowNodes));
}

function normalizeSpreadsheetLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Excel / Sheets clipboard HTML encodes merged cells as rowspan/colspan.
 * Nested markdown tables cannot keep those merges, so expand them into a
 * rectangular grid and copy the origin cell's content into every covered slot.
 */
function expandMergedHtmlCells(tableEl: HTMLTableElement): void {
  const rows = Array.from(tableEl.rows);
  if (rows.length === 0) return;

  const hasSpan = rows.some((row) =>
    Array.from(row.cells).some((cell) => cell.rowSpan > 1 || cell.colSpan > 1)
  );
  if (!hasSpan) return;

  const grid: HTMLTableCellElement[][] = [];

  for (let r = 0; r < rows.length; r++) {
    if (!grid[r]) grid[r] = [];
    let col = 0;
    for (const cell of Array.from(rows[r].cells)) {
      while (grid[r][col]) col++;
      const rowspan = Math.max(1, cell.rowSpan || 1);
      const colspan = Math.max(1, cell.colSpan || 1);
      for (let dr = 0; dr < rowspan; dr++) {
        const targetRow = r + dr;
        if (!grid[targetRow]) grid[targetRow] = [];
        for (let dc = 0; dc < colspan; dc++) {
          const clone = cell.cloneNode(true) as HTMLTableCellElement;
          clone.rowSpan = 1;
          clone.colSpan = 1;
          clone.removeAttribute('rowspan');
          clone.removeAttribute('colspan');
          grid[targetRow][col + dc] = clone;
        }
      }
      col += colspan;
    }
  }

  const rowCount = Math.max(rows.length, grid.length);
  const colCount = Math.max(1, ...grid.map((row) => row.length));
  const doc = tableEl.ownerDocument;
  const parent = tableEl.tBodies[0] ?? tableEl;

  for (let r = 0; r < rowCount; r++) {
    let row = rows[r];
    if (!row) {
      row = doc.createElement('tr');
      parent.appendChild(row);
    }
    while (row.cells.length > 0) {
      row.deleteCell(0);
    }
    for (let c = 0; c < colCount; c++) {
      const cell = grid[r]?.[c];
      if (cell) {
        row.appendChild(cell);
      } else {
        row.appendChild(doc.createElement('td'));
      }
    }
  }
}

function flattenMergedTablesInNode(node: ProsemirrorNode): ProsemirrorNode {
  const content = flattenMergedTablesInFragment(node.content);
  const withContent = content.eq(node.content) ? node : node.copy(content);
  return withContent.type.name === 'table'
    ? flattenMergedTableNode(withContent)
    : withContent;
}

/**
 * Split every merged cell into independent cells, copying the origin value
 * into each covered row/column so the pasted table never keeps rowspan/colspan.
 */
function flattenMergedTableNode(table: ProsemirrorNode): ProsemirrorNode {
  if (table.type.name !== 'table' || !tableHasMergedCells(table)) return table;

  const schema = table.type.schema;
  const occupied: boolean[][] = [];
  const grid: ProsemirrorNode[][] = [];

  table.forEach((row, _offset, rowIndex) => {
    if (!grid[rowIndex]) grid[rowIndex] = [];
    if (!occupied[rowIndex]) occupied[rowIndex] = [];
    let col = 0;
    row.forEach((cell) => {
      while (occupied[rowIndex][col]) col++;
      const rowspan = Math.max(1, Number(cell.attrs.rowspan) || 1);
      const colspan = Math.max(1, Number(cell.attrs.colspan) || 1);
      for (let dr = 0; dr < rowspan; dr++) {
        const targetRow = rowIndex + dr;
        if (!grid[targetRow]) grid[targetRow] = [];
        if (!occupied[targetRow]) occupied[targetRow] = [];
        for (let dc = 0; dc < colspan; dc++) {
          occupied[targetRow][col + dc] = true;
          grid[targetRow][col + dc] = copyCellUnmerged(cell);
        }
      }
      col += colspan;
    });
  });

  const rowCount = Math.max(table.childCount, grid.length);
  const colCount = Math.max(1, ...grid.map((row) => row.length));
  const rowNodes: ProsemirrorNode[] = [];

  for (let r = 0; r < rowCount; r++) {
    const originalRow = r < table.childCount ? table.child(r) : table.child(table.childCount - 1);
    const cells: ProsemirrorNode[] = [];
    const fallbackHeader = originalRow.firstChild?.type.name === 'table_header';
    for (let c = 0; c < colCount; c++) {
      cells.push(grid[r]?.[c] ?? emptyTableCell(schema, fallbackHeader));
    }
    rowNodes.push(originalRow.type.create(originalRow.attrs, cells));
  }

  return table.type.create(table.attrs, rowNodes);
}

function tableHasMergedCells(table: ProsemirrorNode): boolean {
  for (let r = 0; r < table.childCount; r++) {
    const row = table.child(r);
    for (let c = 0; c < row.childCount; c++) {
      const cell = row.child(c);
      if ((cell.attrs.rowspan || 1) > 1 || (cell.attrs.colspan || 1) > 1) return true;
    }
  }
  return false;
}

function copyCellUnmerged(cell: ProsemirrorNode): ProsemirrorNode {
  const json = cell.toJSON();
  json.attrs = { ...cell.attrs, rowspan: 1, colspan: 1 };
  return cell.type.schema.nodeFromJSON(json);
}

function emptyTableCell(schema: Schema, header: boolean): ProsemirrorNode {
  const type = header ? schema.nodes.table_header : schema.nodes.table_cell;
  return type.create(
    { rowspan: 1, colspan: 1 },
    schema.nodes.paragraph.create()
  );
}

function pickClipboardTableElement(document: Document): HTMLTableElement | null {
  const tables = Array.from(document.querySelectorAll('table'));
  if (tables.length === 0) return null;

  // Prefer the fragment table with the most cells (Excel sometimes emits wrappers).
  tables.sort((a, b) => b.querySelectorAll('td,th').length - a.querySelectorAll('td,th').length);
  return tables[0] as HTMLTableElement;
}

function findFirstTable(node: ProsemirrorNode): ProsemirrorNode | null {
  if (node.type.name === 'table') return node;
  let found: ProsemirrorNode | null = null;
  node.descendants((child) => {
    if (found) return false;
    if (child.type.name === 'table') {
      found = child;
      return false;
    }
    return true;
  });
  return found;
}
