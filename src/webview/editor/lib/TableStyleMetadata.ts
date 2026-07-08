import { Fragment, type Node as ProsemirrorNode } from 'prosemirror-model';

export interface EasyViewTableCellMeta {
  row: number;
  cell: number;
  colwidth: number[];
}

export interface EasyViewTableMetaEntry {
  shape: number[];
  cells: EasyViewTableCellMeta[];
}

export interface EasyViewTableMeta {
  version: 1;
  tables: EasyViewTableMetaEntry[];
}

const TABLE_META_RE = /\n{0,2}<!--\s*easyview:table-meta(?:\s+|\r?\n)([\s\S]*?)\s*-->\s*$/;

function hasPositiveColwidths(value: unknown): value is number[] {
  return Array.isArray(value) && value.some((width) => typeof width === 'number' && width > 0);
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

    node.forEach((row, rowIndex) => {
      shape.push(row.childCount);
      row.forEach((cell, cellIndex) => {
        if (hasPositiveColwidths(cell.attrs.colwidth)) {
          cells.push({
            row: rowIndex,
            cell: cellIndex,
            colwidth: cell.attrs.colwidth.map((width: number) => Math.max(1, Math.round(width))),
          });
        }
      });
    });

    if (cells.length > 0) {
      tables.push({ shape, cells });
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

  let tableIndex = 0;
  let changed = false;

  function processNode(node: ProsemirrorNode): ProsemirrorNode {
    if (node.type.name === 'table') {
      const currentMeta = tableIndex < meta.tables.length ? meta.tables[tableIndex] : null;
      tableIndex += 1;

      const processedRows: ProsemirrorNode[] = [];
      let rowChanged = false;
      node.forEach((row) => {
        const nextRow = processNode(row);
        processedRows.push(nextRow);
        if (nextRow !== row) rowChanged = true;
      });

      let nextTable = rowChanged ? node.copy(Fragment.fromArray(processedRows)) : node;
      if (!currentMeta) return nextTable;

      const shapeMatches =
        currentMeta.shape.length === nextTable.childCount &&
        currentMeta.shape.every((cellCount, rowIndex) => nextTable.child(rowIndex)?.childCount === cellCount);

      if (!shapeMatches) return nextTable;

      const updatedRows: ProsemirrorNode[] = [];
      let widthChanged = false;

      nextTable.forEach((row, rowIndex) => {
        const cellMetaByIndex = new Map<number, EasyViewTableCellMeta>();
        currentMeta.cells
          .filter((cellMeta) => cellMeta.row === rowIndex)
          .forEach((cellMeta) => cellMetaByIndex.set(cellMeta.cell, cellMeta));

        const nextCells: ProsemirrorNode[] = [];
        let localChanged = false;

        row.forEach((cell, cellIndex) => {
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

          localChanged = true;
          widthChanged = true;
          nextCells.push(cell.type.create({ ...cell.attrs, colwidth: normalized }, cell.content, cell.marks));
        });

        if (localChanged) {
          updatedRows.push(row.type.create(row.attrs, nextCells, row.marks));
        } else {
          updatedRows.push(row);
        }
      });

      if (widthChanged) {
        changed = true;
        nextTable = nextTable.type.create(nextTable.attrs, updatedRows, nextTable.marks);
      } else if (rowChanged) {
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
