import { Fragment, type Node as ProsemirrorNode } from 'prosemirror-model';

export interface EasyViewTableCellMeta {
  row: number;
  cell: number;
  colwidth: number[];
}

export interface EasyViewTableMetaEntry {
  shape: number[];
  cells: EasyViewTableCellMeta[];
  rowHeights?: number[];
}

export interface EasyViewTableMeta {
  version: 1;
  tables: EasyViewTableMetaEntry[];
}

const TABLE_META_RE = /\n{0,2}<!--\s*easyview:table-meta(?:\s+|\r?\n)([\s\S]*?)\s*-->\s*$/;

function hasPositiveColwidths(value: unknown): value is number[] {
  return Array.isArray(value) && value.some((width) => typeof width === 'number' && width > 0);
}

function normalizeRowHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(36, Math.min(1200, Math.round(value)));
}

export function stripEasyViewTableMeta(markdown: string): {
  content: string;
  meta: EasyViewTableMeta | null;
} {
  const match = markdown.match(TABLE_META_RE);
  if (!match) {
    return { content: markdown, meta: null };
  }

  let meta: EasyViewTableMeta | null = null;
  try {
    const parsed = JSON.parse(match[1]);
    if (parsed && parsed.version === 1 && Array.isArray(parsed.tables)) {
      meta = parsed as EasyViewTableMeta;
    }
  } catch {
    meta = null;
  }

  return {
    content: markdown.slice(0, match.index).replace(/\s+$/, ''),
    meta,
  };
}

export function collectEasyViewTableMeta(doc: ProsemirrorNode): EasyViewTableMeta | null {
  const tables: EasyViewTableMetaEntry[] = [];

  doc.descendants((node) => {
    if (node.type.name !== 'table') return true;

    const shape: number[] = [];
    const cells: EasyViewTableCellMeta[] = [];
    const rowHeights: Array<number | null> = [];
    let hasRowHeights = false;

    node.forEach((row, _rowOffset, rowIndex) => {
      shape.push(row.childCount);
      const height = normalizeRowHeight(row.attrs.height);
      rowHeights.push(height);
      if (height !== null) hasRowHeights = true;
      row.forEach((cell, _cellOffset, cellIndex) => {
        if (hasPositiveColwidths(cell.attrs.colwidth)) {
          cells.push({
            row: rowIndex,
            cell: cellIndex,
            colwidth: cell.attrs.colwidth.map((width: number) => Math.max(1, Math.round(width))),
          });
        }
      });
    });

    if (cells.length > 0 || hasRowHeights) {
      tables.push({
        shape,
        cells,
        ...(hasRowHeights ? { rowHeights: rowHeights.map((height) => height ?? 0) } : {}),
      });
    }

    return true;
  });

  return tables.length ? { version: 1, tables } : null;
}

export function appendEasyViewTableMeta(markdown: string, meta: EasyViewTableMeta | null): string {
  const base = markdown.replace(/\s+$/, '');
  if (!meta || meta.tables.length === 0) {
    return base ? `${base}\n` : '';
  }

  return `${base}\n\n<!-- easyview:table-meta ${JSON.stringify(meta)} -->\n`;
}

export function applyEasyViewTableMeta(doc: ProsemirrorNode, meta: EasyViewTableMeta | null): ProsemirrorNode {
  if (!meta?.tables?.length) return doc;

  const tableMeta = meta;
  let tableIndex = 0;
  let changed = false;

  function processNode(node: ProsemirrorNode): ProsemirrorNode {
    if (node.type.name === 'table') {
      const currentMeta = tableIndex < tableMeta.tables.length ? tableMeta.tables[tableIndex] : null;
      tableIndex += 1;

      const shapeMatches =
        currentMeta?.shape.length === node.childCount &&
        currentMeta.shape.every((cellCount, rowIndex) => node.child(rowIndex)?.childCount === cellCount);
      const processedRows: ProsemirrorNode[] = [];
      let childChanged = false;
      node.forEach((row) => {
        const nextRow = processNode(row);
        processedRows.push(nextRow);
        if (nextRow !== row) childChanged = true;
      });

      let nextTable = childChanged ? node.copy(Fragment.fromArray(processedRows)) : node;
      if (!currentMeta || !shapeMatches) return nextTable;
      const updatedRows: ProsemirrorNode[] = [];
      let tableChanged = false;

      nextTable.forEach((row, _rowOffset, rowIndex) => {
        const cellMetaByIndex = new Map<number, EasyViewTableCellMeta>();
        currentMeta.cells
          .filter((cellMeta) => cellMeta.row === rowIndex)
          .forEach((cellMeta) => cellMetaByIndex.set(cellMeta.cell, cellMeta));

        const nextCells: ProsemirrorNode[] = [];
        let rowChanged = false;
        row.forEach((cell, _cellOffset, cellIndex) => {
          const cellMeta = cellMetaByIndex.get(cellIndex);
          if (!cellMeta || !hasPositiveColwidths(cellMeta.colwidth)) {
            nextCells.push(cell);
            return;
          }

          const normalized = cellMeta.colwidth.map((width) => Math.max(1, Math.round(width)));
          const existing = hasPositiveColwidths(cell.attrs.colwidth) ? cell.attrs.colwidth : null;
          const same =
            existing &&
            existing.length === normalized.length &&
            existing.every((value: number, idx: number) => value === normalized[idx]);

          if (same) {
            nextCells.push(cell);
            return;
          }

          rowChanged = true;
          nextCells.push(cell.type.create({ ...cell.attrs, colwidth: normalized }, cell.content, cell.marks));
        });

        const height = normalizeRowHeight(currentMeta.rowHeights?.[rowIndex]);
        const rowAttrs = height === null ? row.attrs : { ...row.attrs, height };
        const heightChanged = height !== null && row.attrs.height !== height;
        if (rowChanged || heightChanged) {
          updatedRows.push(row.type.create(rowAttrs, nextCells, row.marks));
          tableChanged = true;
        } else {
          updatedRows.push(row);
        }
      });

      if (tableChanged) {
        changed = true;
        nextTable = nextTable.type.create(nextTable.attrs, updatedRows, nextTable.marks);
      } else if (childChanged) {
        changed = true;
      }

      return nextTable;
    }

    if (node.childCount === 0) return node;

    const nextChildren: ProsemirrorNode[] = [];
    let childChanged = false;
    node.forEach((child) => {
      const nextChild = processNode(child);
      nextChildren.push(nextChild);
      if (nextChild !== child) childChanged = true;
    });

    if (!childChanged) return node;
    changed = true;
    return node.copy(Fragment.fromArray(nextChildren));
  }

  const nextDoc = processNode(doc);
  return changed ? nextDoc : doc;
}
