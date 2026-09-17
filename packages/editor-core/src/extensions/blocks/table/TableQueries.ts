/**
 * Table Query Helpers
 *
 * Helper functions for querying and working with tables in ProseMirror.
 * Ported from Outline's shared/editor/queries/table.ts
 */

import { EditorState, Selection } from 'prosemirror-state';
import { Node as ProsemirrorNode, ResolvedPos } from 'prosemirror-model';
import { CellSelection, TableMap, selectedRect, Rect, TableRect } from 'prosemirror-tables';

/**
 * Get all cells in a specific row
 */
export function getCellsInRow(rowIndex: number) {
  return (state: EditorState): number[] => {
    const rect = selectedRect(state);
    const cells: number[] = [];
    const map = TableMap.get(rect.table);

    for (let col = 0; col < rect.map.width; col++) {
      const cellPos = map.map[rowIndex * rect.map.width + col];
      cells.push(rect.tableStart + cellPos);
    }

    return cells;
  };
}

/**
 * Get all cells in a specific column
 */
export function getCellsInColumn(columnIndex: number) {
  return (state: EditorState): number[] => {
    const rect = selectedRect(state);
    const cells: number[] = [];
    const map = TableMap.get(rect.table);

    for (let row = 0; row < rect.map.height; row++) {
      const cellPos = map.map[row * rect.map.width + columnIndex];
      cells.push(rect.tableStart + cellPos);
    }

    return cells;
  };
}

/**
 * Get all rows in the table
 */
export function getRowsInTable(state: EditorState): number[] {
  const rect = selectedRect(state);
  const rows: number[] = [];
  const map = TableMap.get(rect.table);

  for (let row = 0; row < rect.map.height; row++) {
    const cellPos = map.map[row * rect.map.width];
    rows.push(rect.tableStart + cellPos);
  }

  return rows;
}

/**
 * Check if the current selection is a row selection
 */
export function isRowSelection(selection: Selection): boolean {
  if (!(selection instanceof CellSelection)) {
    return false;
  }

  const rect = selectedRect({ selection } as any);
  return rect.left === 0 && rect.right === rect.map.width;
}

/**
 * Check if the current selection is a column selection
 */
export function isColumnSelection(selection: Selection): boolean {
  if (!(selection instanceof CellSelection)) {
    return false;
  }

  const rect = selectedRect({ selection } as any);
  return rect.top === 0 && rect.bottom === rect.map.height;
}

/**
 * Get the index of the row containing the current selection
 */
export function getRowIndex(state: EditorState): number {
  const rect = selectedRect(state);
  return rect.top;
}

/**
 * Get the index of the column containing the current selection
 */
export function getColumnIndex(state: EditorState): number {
  const rect = selectedRect(state);
  return rect.left;
}

/**
 * Get all selected column indices
 */
export function getAllSelectedColumns(selection: Selection): number[] {
  if (!isColumnSelection(selection)) {
    return [];
  }

  const rect = selectedRect({ selection } as any);
  const columns: number[] = [];

  for (let col = rect.left; col < rect.right; col++) {
    columns.push(col);
  }

  return columns;
}

/**
 * Get all selected row indices
 */
export function getAllSelectedRows(selection: Selection): number[] {
  if (!isRowSelection(selection)) {
    return [];
  }

  const rect = selectedRect({ selection } as any);
  const rows: number[] = [];

  for (let row = rect.top; row < rect.bottom; row++) {
    rows.push(row);
  }

  return rows;
}

/**
 * Find the table node containing the given position
 */
export function findTable(selection: Selection): { node: ProsemirrorNode; pos: number } | undefined {
  const { $from } = selection;

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.spec.tableRole === 'table') {
      return {
        node,
        pos: $from.before(depth),
      };
    }
  }

  return undefined;
}

/**
 * Check if the selection is inside a table
 */
export function isInTable(state: EditorState): boolean {
  return !!findTable(state.selection);
}

/**
 * Get the table map for the current selection
 */
export function getTableMap(state: EditorState): TableMap | undefined {
  const table = findTable(state.selection);
  if (!table) {
    return undefined;
  }
  return TableMap.get(table.node);
}

/**
 * Get the number of rows in the table
 */
export function getRowCount(state: EditorState): number {
  const map = getTableMap(state);
  return map ? map.height : 0;
}

/**
 * Get the number of columns in the table
 */
export function getColumnCount(state: EditorState): number {
  const map = getTableMap(state);
  return map ? map.width : 0;
}

/**
 * Check if header is enabled for row or column
 */
export function isHeaderEnabled(
  state: EditorState,
  type: "row" | "column",
  rect: TableRect
): boolean {
  // Get cell positions for first row or first column
  const cellPositions = rect.map.cellsInRect({
    left: 0,
    top: 0,
    right: type === "row" ? rect.map.width : 1,
    bottom: type === "column" ? rect.map.height : 1,
  });

  for (let i = 0; i < cellPositions.length; i++) {
    const cell = rect.table.nodeAt(cellPositions[i]);
    if (cell && cell.type !== state.schema.nodes.table_header) {
      return false;
    }
  }

  return true;
}

/**
 * Check if an entire table is selected in the editor.
 * Copied from Outline's shared/editor/queries/table.ts
 *
 * @param state The editor state
 * @returns Boolean indicating if the table is selected
 */
export function isTableSelected(state: EditorState): boolean {
  if (state.selection instanceof CellSelection) {
    const rect = selectedRect(state);

    return (
      rect.top === 0 &&
      rect.left === 0 &&
      rect.bottom === rect.map.height &&
      rect.right === rect.map.width &&
      !state.selection.empty
    );
  }

  return false;
}
