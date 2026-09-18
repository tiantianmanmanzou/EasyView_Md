import { Fragment, type Node as ProsemirrorNode } from 'prosemirror-model';
import { TableMap } from 'prosemirror-tables';

export interface EasyViewTableCellMeta {
  row: number;
  cell: number;
  colwidth: number[];
}

export interface EasyViewTableMetaEntry {
  shape: number[];
  cells: EasyViewTableCellMeta[];
  /** Logical per-column widths (width[column]). Decoupled from row structure. */
  colWidths?: number[];
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

function normalizeColWidth(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(1, Math.round(value));
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

/**
 * Collect logical per-column widths from the first row of a table.
 * Row structure (row count, rowspans) does not affect this result, which is
 * what allows widths to survive row/rowspan edits.
 */
function collectTableColWidths(tableNode: ProsemirrorNode): number[] | null {
  const map = TableMap.get(tableNode);
  if (map.width <= 0) return null;

  const widths = new Array<number>(map.width).fill(0);
  const firstRow = tableNode.firstChild;
  if (!firstRow) return null;

  let columnIndex = 0;
  firstRow.forEach((cell) => {
    const colspan = Math.max(1, cell.attrs.colspan ?? 1);
    const colwidth = cell.attrs.colwidth;
    for (let offset = 0; offset < colspan && columnIndex + offset < map.width; offset++) {
      const width = Array.isArray(colwidth) ? colwidth[offset] : null;
      const normalized = normalizeColWidth(width);
      if (normalized !== null) widths[columnIndex + offset] = normalized;
    }
    columnIndex += colspan;
  });

  return widths.some((width) => width > 0) ? widths : null;
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

    const colWidths = collectTableColWidths(node);
    if (cells.length > 0 || hasRowHeights || colWidths) {
      tables.push({
        shape,
        cells,
        ...(colWidths ? { colWidths } : {}),
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

/**
 * Resolve logical per-column widths from table metadata.
 *
 * Prefers the new table-level `colWidths` field; falls back to deriving widths
 * from the legacy per-cell metadata of the header row (row 0), which is how
 * old meta versions stored column widths.
 */
function resolveTableColWidths(meta: EasyViewTableMetaEntry): number[] | null {
  if (Array.isArray(meta.colWidths)) {
    const widths = meta.colWidths
      .map((width) => normalizeColWidth(width))
      .filter((width): width is number => width !== null);
    if (widths.length > 0) return widths;
  }

  const headerCells = meta.cells
    .filter((cellMeta) => cellMeta.row === 0)
    .sort((a, b) => a.cell - b.cell);
  if (headerCells.length === 0) return null;

  const widths: number[] = [];
  for (const cellMeta of headerCells) {
    if (!hasPositiveColwidths(cellMeta.colwidth)) continue;
    for (const width of cellMeta.colwidth) {
      const normalized = normalizeColWidth(width);
      if (normalized !== null) widths.push(normalized);
    }
  }

  return widths.length > 0 ? widths : null;
}

/**
 * Build the per-cell colwidth array for a cell that starts at `columnIndex`
 * (colspan-aware), or null when the cell falls outside the known widths.
 */
function colWidthsForCell(colWidths: number[], columnIndex: number, colspan: number): number[] | null {
  const slice = colWidths.slice(columnIndex, columnIndex + colspan);
  if (slice.length !== colspan || !slice.some((width) => width > 0)) return null;
  return slice;
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
      if (!currentMeta) return nextTable;

      // Prefer exact per-cell widths when the structure still matches the
      // saved shape. When rows/rowspans changed, fall back to logical-column
      // widths so a structural edit never silently discards the saved widths.
      const usePerCellWidths = shapeMatches && currentMeta.cells.length > 0;
      const colWidths = usePerCellWidths ? null : resolveTableColWidths(currentMeta);

      const updatedRows: ProsemirrorNode[] = [];
      let tableChanged = false;

      nextTable.forEach((row, _rowOffset, rowIndex) => {
        const cellMetaByIndex = new Map<number, EasyViewTableCellMeta>();
        if (shapeMatches) {
          currentMeta.cells
            .filter((cellMeta) => cellMeta.row === rowIndex)
            .forEach((cellMeta) => cellMetaByIndex.set(cellMeta.cell, cellMeta));
        }

        const nextCells: ProsemirrorNode[] = [];
        let rowChanged = false;
        let columnIndex = 0;

        row.forEach((cell, _cellOffset, cellIndex) => {
          const colspan = Math.max(1, cell.attrs.colspan ?? 1);
          let nextColwidth: number[] | null = null;

          if (colWidths) {
            nextColwidth = colWidthsForCell(colWidths, columnIndex, colspan);
          } else {
            const cellMeta = cellMetaByIndex.get(cellIndex);
            if (cellMeta && hasPositiveColwidths(cellMeta.colwidth)) {
              nextColwidth = cellMeta.colwidth.map((width: number) => Math.max(1, Math.round(width)));
            }
          }

          let nextCell = cell;
          if (nextColwidth) {
            const normalized = nextColwidth.map((width: number) => Math.max(1, Math.round(width)));
            const existing = hasPositiveColwidths(cell.attrs.colwidth) ? cell.attrs.colwidth : null;
            const same =
              existing &&
              existing.length === normalized.length &&
              existing.every((value: number, idx: number) => value === normalized[idx]);

            if (!same) {
              nextCell = cell.type.create({ ...cell.attrs, colwidth: normalized }, cell.content, cell.marks);
              rowChanged = true;
            }
          }

          nextCells.push(nextCell);
          columnIndex += colspan;
        });

        // Row heights are a per-row property and do not depend on cell
        // structure, so they are restored by index even when the shape
        // changed. Rows beyond the saved metadata keep their current height.
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
