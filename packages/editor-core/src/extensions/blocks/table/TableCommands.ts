/**
 * Table Commands
 *
 * ProseMirror commands for table operations.
 * Copied from Outline's shared/editor/commands/table.ts
 */

import type { Attrs, Node, NodeType } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import {
  CellSelection,
  TableMap,
  addRow,
  isInTable,
  selectedRect,
  type TableRect,
  tableNodeTypes,
  toggleHeader,
  addColumn,
  deleteRow,
  deleteColumn,
  deleteTable,
  mergeCells,
  splitCell,
  moveTableRow,
  moveTableColumn,
} from "prosemirror-tables";
import { chainTransactions } from "./ChainTransactions";
import {
  getCellsInColumn,
  getCellsInRow,
  isHeaderEnabled,
  getRowIndex,
  getColumnIndex,
  isTableSelected,
} from "./TableQueries";
import { collapseSelection } from "./CollapseSelection";
import { RowSelection } from "./RowSelection";
import { getFirstRowStickyDefault } from "./TablePreferences";
import { ColumnSelection } from "./ColumnSelection";

export function createTable({
  rowsCount,
  colsCount,
  colWidth,
}: {
  rowsCount: number;
  colsCount: number;
  colWidth: number;
}): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const offset = state.tr.selection.anchor + 1;
      const nodes = createTableInner(state, rowsCount, colsCount, colWidth);
      const tr = state.tr.replaceSelectionWith(nodes).scrollIntoView();
      const resolvedPos = tr.doc.resolve(offset);
      tr.setSelection(TextSelection.near(resolvedPos));
      dispatch(tr);
    }
    return true;
  };
}

export function createTableInner(
  state: EditorState,
  rowsCount: number,
  colsCount: number,
  colWidth?: number,
  withHeaderRow = true,
  cellContent?: Node
) {
  const types = tableNodeTypes(state.schema);
  const headerCells: Node[] = [];
  const cells: Node[] = [];
  const rows: Node[] = [];

  const createCell = (cellType: NodeType, attrs: Attrs | null) =>
    cellContent
      ? cellType.createChecked(attrs, cellContent)
      : cellType.createAndFill(attrs);

  for (let index = 0; index < colsCount; index += 1) {
    const attrs =
      colWidth && index < colsCount - 1
        ? {
            colwidth: [colWidth],
            colspan: 1,
            rowspan: 1,
          }
        : null;
    const cell = createCell(types.cell, attrs);

    if (cell) {
      cells.push(cell);
    }

    if (withHeaderRow) {
      const headerCell = createCell(types.header_cell, attrs);

      if (headerCell) {
        headerCells.push(headerCell);
      }
    }
  }

  for (let index = 0; index < rowsCount; index += 1) {
    rows.push(
      types.row.createChecked(
        withHeaderRow && index === 0 ? { sticky: getFirstRowStickyDefault() } : null,
        withHeaderRow && index === 0 ? headerCells : cells
      )
    );
  }

  return types.table.createChecked(null, rows);
}

export function sortTable({
  index,
  direction,
}: {
  index: number;
  direction: "asc" | "desc";
}): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) {
      return false;
    }

    if (dispatch) {
      const rect = selectedRect(state);
      const table: Node[][] = [];

      for (let r = 0; r < rect.map.height; r++) {
        const cells = [];
        for (let c = 0; c < rect.map.width; c++) {
          const cell = state.doc.nodeAt(
            rect.tableStart + rect.map.map[r * rect.map.width + c]
          );
          if (cell) {
            cells.push(cell);
          }
        }
        table.push(cells);
      }

      const hasHeaderRow = table[0].every(
        (cell) => cell.type === state.schema.nodes.table_header
      );

      // remove the header row
      const header = hasHeaderRow ? table.shift() : undefined;

      // column data before sort
      const columnData = table.map((row) => row[index]?.textContent ?? "");

      // determine sorting type: number or text
      let compareAsNumber = false;

      const nonEmptyCells = table
        .map((row) => row[index]?.textContent?.trim())
        .filter((cell): cell is string => !!cell && cell.length > 0);
      if (nonEmptyCells.length > 0) {
        compareAsNumber = nonEmptyCells.every(
          (cell) => !isNaN(parseFloat(cell))
        );
      }

      // sort table data based on column at index
      table.sort((a, b) => {
        const aContent = a[index]?.textContent ?? "";
        const bContent = b[index]?.textContent ?? "";

        // empty cells always go to the end
        if (!aContent) {
          return bContent ? 1 : 0;
        }
        if (!bContent) {
          return -1;
        }

        if (compareAsNumber) {
          return parseFloat(aContent) - parseFloat(bContent);
        } else {
          return aContent.localeCompare(bContent);
        }
      });

      if (direction === "desc") {
        table.reverse();
      }

      // check if column data changed, if not then do not replace table
      if (
        columnData.join() === table.map((row) => row[index]?.textContent).join()
      ) {
        return true;
      }

      // add the header row back
      if (header) {
        table.unshift(header);
      }

      // create the new table
      const rows = [];
      for (let i = 0; i < table.length; i += 1) {
        rows.push(state.schema.nodes.table_row.createChecked(null, table[i]));
      }

      // replace the original table with this sorted one
      const nodes = state.schema.nodes.table.createChecked(
        rect.table.attrs,
        rows
      );
      let { tr } = state;

      tr = tr.replaceRangeWith(
        rect.tableStart - 1,
        rect.tableStart - 1 + rect.table.nodeSize,
        nodes
      );

      // Restore column selection after sorting
      // Find the new table position and select the sorted column
      const newTableStart = rect.tableStart - 1 + 1; // Table position after replace
      const newDoc = tr.doc;
      const newTable = newDoc.nodeAt(newTableStart - 1);

      if (newTable && newTable.type === state.schema.nodes.table) {
        const newMap = TableMap.get(newTable);
        const cellPos = newMap.map[index];
        const $pos = tr.doc.resolve(newTableStart + cellPos);
        const colSelection = ColumnSelection.colSelection($pos);
        tr = tr.setSelection(colSelection);
      }

      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/**
 * A command that safely adds a row taking into account any existing heading column at the top of
 * the table, and preventing it moving "into" the table.
 *
 * @param index The index to add the row at, if undefined the current selection is used
 * @returns The command
 */
export function addRowBefore({ index }: { index?: number }): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) {
      return false;
    }

    const rect = selectedRect(state);
    const isHeaderRowEnabled = isHeaderEnabled(state, "row", rect);
    const position = index !== undefined ? index : rect.left;

    // Special case when adding row to the beginning of the table to ensure the header does not
    // move inwards.
    const headerSpecialCase = position === 0 && isHeaderRowEnabled;

    // Determine which row to copy alignment from (using original table indices)
    // When inserting at position 0, copy from original row 0
    // When inserting at other positions, copy from the row above (position - 1)
    const copyFromRow = position === 0 ? 0 : position - 1;

    chainTransactions(
      headerSpecialCase ? toggleHeader("row") : undefined,
      (s, d) =>
        !!d?.(addRowWithAlignment(s.tr, rect, position, copyFromRow, s)),
      headerSpecialCase ? toggleHeader("row") : undefined,
      collapseSelection()
    )(state, dispatch);

    return true;
  };
}

/**
 * A command that deletes the current selected row, if any.
 *
 * @returns The command
 */
export function deleteRowSelection(): Command {
  return (state, dispatch) => {
    if (
      state.selection instanceof CellSelection &&
      state.selection.isRowSelection()
    ) {
      return deleteRow(state, dispatch);
    }
    return false;
  };
}

/**
 * A command that deletes the current selected column, if any.
 *
 * @returns The command
 */
export function deleteColSelection(): Command {
  return (state, dispatch) => {
    if (
      state.selection instanceof CellSelection &&
      state.selection.isColSelection()
    ) {
      return deleteColumn(state, dispatch);
    }
    return false;
  };
}

/**
 * A command that safely adds a column taking into account any existing heading column on the far
 * left of the table, and preventing it moving "into" the table.
 *
 * @param index The index to add the column at, if undefined the current selection is used
 * @returns The command
 */
export function addColumnBefore({ index }: { index?: number }): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) {
      return false;
    }

    const rect = selectedRect(state);
    const isHeaderColumnEnabled = isHeaderEnabled(state, "column", rect);
    const position = index !== undefined ? index : rect.left;

    // Special case when adding column to the beginning of the table to ensure the header does not
    // move inwards.
    const headerSpecialCase = position === 0 && isHeaderColumnEnabled;

    chainTransactions(
      headerSpecialCase ? toggleHeader("column") : undefined,
      (s, d) => !!d?.(addColumn(s.tr, rect, position)),
      headerSpecialCase ? toggleHeader("column") : undefined,
      collapseSelection()
    )(state, dispatch);

    return true;
  };
}

export function addRowAndMoveSelection({
  index,
}: {
  index?: number;
} = {}): Command {
  return (state, dispatch, view) => {
    if (!isInTable(state)) {
      return false;
    }

    const rect = selectedRect(state);
    const cells = getCellsInColumn(0)(state);

    // If the cursor is at the beginning of the first column then insert row
    // above instead of below.
    if (rect.left === 0 && view?.endOfTextblock("backward", state)) {
      const indexBefore = index !== undefined ? index - 1 : rect.top;
      // Copy alignment from the current row (which will be pushed down)
      const copyFromRow = indexBefore;
      dispatch?.(
        addRowWithAlignment(state.tr, rect, indexBefore, copyFromRow, state)
      );
      return true;
    }

    const indexAfter = index !== undefined ? index + 1 : rect.bottom;
    // Copy alignment from the row above the insertion point
    const copyFromRow = indexAfter > 0 ? indexAfter - 1 : undefined;
    const tr = addRowWithAlignment(
      state.tr,
      rect,
      indexAfter,
      copyFromRow,
      state
    );

    // Special case when adding row to the end of the table as the calculated
    // rect does not include the row that we just added.
    if (indexAfter !== rect.map.height) {
      const pos = cells[Math.min(cells.length - 1, indexAfter)];
      const $pos = tr.doc.resolve(pos);
      dispatch?.(tr.setSelection(TextSelection.near($pos)));
    } else {
      const $pos = tr.doc.resolve(rect.tableStart + rect.table.nodeSize);
      dispatch?.(tr.setSelection(TextSelection.near($pos)));
    }

    return true;
  };
}

/**
 * Set column attributes. Passed attributes will be merged with existing.
 *
 * @param attrs The attributes to set
 * @returns The command
 */
/** Toggle persistent sticky rendering for the table's first row. */
export function setFirstRowSticky(sticky: boolean): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;

    const rect = selectedRect(state);
    const firstRowPos = rect.tableStart;
    const firstRow = state.doc.nodeAt(firstRowPos);
    if (!firstRow || firstRow.type.name !== 'table_row') return false;

    if (dispatch) {
      dispatch(state.tr.setNodeMarkup(firstRowPos, undefined, {
        ...firstRow.attrs,
        sticky,
      }));
    }
    return true;
  };
}

export function setColumnAttr({
  index,
  alignment,
  verticalAlignment,
}: {
  index: number;
  alignment?: string | null;
  verticalAlignment?: string | null;
}): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const cells = getCellsInColumn(index)(state) || [];
      let transaction = state.tr;
      cells.forEach((pos) => {
        const node = state.doc.nodeAt(pos);
        transaction = transaction.setNodeMarkup(pos, undefined, {
          ...node?.attrs,
          ...(alignment !== undefined ? { alignment } : {}),
          ...(verticalAlignment !== undefined ? { verticalAlignment } : {}),
        });
      });
      dispatch(transaction);
    }
    return true;
  };
}

export function setRowAttr({
  index,
  alignment,
  verticalAlignment,
}: {
  index: number;
  alignment?: string | null;
  verticalAlignment?: string | null;
}): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const cells = getCellsInRow(index)(state) || [];
      let transaction = state.tr;
      cells.forEach((pos) => {
        const node = state.doc.nodeAt(pos);
        transaction = transaction.setNodeMarkup(pos, undefined, {
          ...node?.attrs,
          ...(alignment !== undefined ? { alignment } : {}),
          ...(verticalAlignment !== undefined ? { verticalAlignment } : {}),
        });
      });
      dispatch(transaction);
    }
    return true;
  };
}

const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 960;

function clampColumnWidth(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
}

function applyColumnWidths(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  targetColumns: number[],
  resolveWidth: (currentWidth: number) => number,
  fallbackWidth?: number
): boolean {
  if (!isInTable(state)) return false;
  if (targetColumns.length === 0) return false;

  if (dispatch) {
    const rect = selectedRect(state);
    const baseFallbackWidth = clampColumnWidth(fallbackWidth || 120);
    const nextStateDoc = state.doc;
    let transaction = state.tr;
    const seen = new Set<number>();

    for (let row = 0; row < rect.map.height; row++) {
      for (const columnIndex of targetColumns) {
        if (columnIndex < 0 || columnIndex >= rect.map.width) continue;
        const mapPos = rect.map.map[row * rect.map.width + columnIndex];
        const cellPos = rect.tableStart + mapPos;
        if (seen.has(cellPos)) continue;
        seen.add(cellPos);

        const cell = nextStateDoc.nodeAt(cellPos);
        if (!cell) continue;

        const cellRect = rect.map.findCell(mapPos);
        const colspan = Math.max(1, cell.attrs.colspan || 1);
        const slotIndex = Math.max(0, Math.min(colspan - 1, columnIndex - cellRect.left));
        const existingWidths = Array.isArray(cell.attrs.colwidth)
          ? cell.attrs.colwidth.slice(0, colspan)
          : [];
        while (existingWidths.length < colspan) existingWidths.push(baseFallbackWidth);

        const currentWidth = typeof existingWidths[slotIndex] === 'number' && existingWidths[slotIndex] > 0
          ? existingWidths[slotIndex]
          : baseFallbackWidth;
        existingWidths[slotIndex] = clampColumnWidth(resolveWidth(currentWidth));

        transaction = transaction.setNodeMarkup(cellPos, undefined, {
          ...cell.attrs,
          colwidth: existingWidths,
        });
      }
    }

    dispatch(transaction);
  }

  return true;
}

function resolveTargetColumns(state: EditorState, index: number): number[] {
  const rect = selectedRect(state);
  if (state.selection instanceof CellSelection && state.selection.isColSelection()) {
    return Array.from({ length: rect.right - rect.left }, (_, offset) => rect.left + offset);
  }
  return [index];
}

function allColumnIndexes(state: EditorState): number[] {
  const rect = selectedRect(state);
  return Array.from({ length: rect.map.width }, (_, index) => index);
}

export function adjustColumnWidth({
  index,
  delta,
  fallbackWidth,
}: {
  index: number;
  delta: number;
  fallbackWidth?: number;
}): Command {
  return (state, dispatch) =>
    applyColumnWidths(
      state,
      dispatch,
      resolveTargetColumns(state, index),
      (current) => current + delta,
      fallbackWidth
    );
}

export function setColumnWidth({
  index,
  width,
  fallbackWidth,
}: {
  index: number;
  width: number;
  fallbackWidth?: number;
}): Command {
  return (state, dispatch) =>
    applyColumnWidths(state, dispatch, resolveTargetColumns(state, index), () => width, fallbackWidth);
}

export function adjustAllColumnWidths({
  delta,
  fallbackWidth,
}: {
  delta: number;
  fallbackWidth?: number;
}): Command {
  return (state, dispatch) =>
    applyColumnWidths(
      state,
      dispatch,
      allColumnIndexes(state),
      (current) => current + delta,
      fallbackWidth
    );
}

export function setAllColumnWidths({
  width,
  fallbackWidth,
}: {
  width: number;
  fallbackWidth?: number;
}): Command {
  return (state, dispatch) =>
    applyColumnWidths(state, dispatch, allColumnIndexes(state), () => width, fallbackWidth);
}

const MIN_ROW_HEIGHT = 36;
const MAX_ROW_HEIGHT = 1200;

function normalizeRowHeight(height: number): number {
  return Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, Math.round(height)));
}

function setTableRowHeights(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  resolveHeight: (currentHeight: number) => number,
  fallbackHeight = 48,
): boolean {
  if (!isInTable(state)) return false;
  if (!dispatch) return true;

  const rect = selectedRect(state);
  let tr = state.tr;
  let rowPos = rect.tableStart;
  for (let rowIndex = 0; rowIndex < rect.table.childCount; rowIndex += 1) {
    const row = rect.table.child(rowIndex);
    const current = typeof row.attrs.height === 'number' && row.attrs.height > 0
      ? row.attrs.height
      : fallbackHeight;
    const height = normalizeRowHeight(resolveHeight(current));
    if (row.attrs.height !== height) {
      tr = tr.setNodeMarkup(rowPos, undefined, { ...row.attrs, height });
    }
    rowPos += row.nodeSize;
  }
  if (tr.docChanged) dispatch(tr);
  return true;
}

/** Resize every row in the current table by a fixed pixel delta. */
export function adjustAllRowHeights({ delta, fallbackHeight }: {
  delta: number;
  fallbackHeight?: number;
}): Command {
  return (state, dispatch) =>
    setTableRowHeights(state, dispatch, (current) => current + delta, fallbackHeight);
}

/** Set every row in the current table to the same pixel height. */
export function setAllRowHeights({ height, fallbackHeight }: {
  height: number;
  fallbackHeight?: number;
}): Command {
  return (state, dispatch) =>
    setTableRowHeights(state, dispatch, () => height, fallbackHeight);
}

/** Return a concrete editable row height for the current table. */
export function getRepresentativeRowHeight(state: EditorState, fallbackHeight = 48): number {
  if (!isInTable(state)) return fallbackHeight;
  const rect = selectedRect(state);
  const firstRow = rect.table.firstChild;
  const height = firstRow?.attrs.height;
  return typeof height === 'number' && height > 0 ? Math.round(height) : fallbackHeight;
}

export function selectRow(index: number, expand = false): Command {
  return (state: EditorState, dispatch): boolean => {
    if (dispatch) {
      const rect = selectedRect(state);
      const pos = rect.map.positionAt(index, 0, rect.table);
      const $pos = state.doc.resolve(rect.tableStart + pos);
      const rowSelection =
        expand && state.selection instanceof CellSelection
          ? RowSelection.rowSelection(state.selection.$anchorCell, $pos, index)
          : RowSelection.rowSelection($pos, $pos, index);
      dispatch(state.tr.setSelection(rowSelection));
      return true;
    }
    return false;
  };
}

export function selectColumn(index: number, expand = false): Command {
  return (state, dispatch): boolean => {
    if (dispatch) {
      const rect = selectedRect(state);
      const pos = rect.map.positionAt(0, index, rect.table);
      const $pos = state.doc.resolve(rect.tableStart + pos);
      const colSelection =
        expand && state.selection instanceof CellSelection
          ? ColumnSelection.colSelection(state.selection.$anchorCell, $pos)
          : ColumnSelection.colSelection($pos);
      dispatch(state.tr.setSelection(colSelection));
      return true;
    }
    return false;
  };
}

export function selectTable(): Command {
  return (state, dispatch): boolean => {
    if (dispatch) {
      const rect = selectedRect(state);
      const map = rect.map.map;
      const $anchor = state.doc.resolve(rect.tableStart + map[0]);
      const $head = state.doc.resolve(rect.tableStart + map[map.length - 1]);
      const tableSelection = new CellSelection($anchor, $head);
      dispatch(state.tr.setSelection(tableSelection));
      return true;
    }
    return false;
  };
}

/**
 * A command that merges selected cells and collapses the selection.
 *
 * @returns The command
 */
export function mergeCellsAndCollapse(): Command {
  return chainTransactions(mergeCells, collapseSelection());
}

/**
 * A command that splits the first merged cell found in the selection and
 * collapses the selection. Works with both single cell and multi-cell selections.
 *
 * @returns The command
 */
export function splitCellAndCollapse(): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) {
      return false;
    }

    const { selection } = state;

    // Handle CellSelection (including RowSelection and ColumnSelection which extend it)
    if (
      selection instanceof CellSelection ||
      selection instanceof RowSelection ||
      selection instanceof ColumnSelection
    ) {
      // Find the first merged cell in the selection
      let mergedCellPos: number | null = null;
      selection.forEachCell((cell, pos) => {
        if (
          mergedCellPos === null &&
          (cell.attrs.colspan > 1 || cell.attrs.rowspan > 1)
        ) {
          mergedCellPos = pos;
        }
      });

      // If no merged cell found, nothing to split
      if (mergedCellPos === null) {
        return false;
      }

      if (dispatch) {
        // Create a CellSelection for the merged cell and apply splitCell
        const $cell = state.doc.resolve(mergedCellPos);
        const cellSelection = new CellSelection($cell);
        const stateWithCellSelection = state.apply(
          state.tr.setSelection(cellSelection)
        );

        // Apply splitCell and collapse
        chainTransactions(splitCell, collapseSelection())(
          stateWithCellSelection,
          dispatch
        );
      }

      return true;
    }

    // Fallback to standard splitCell for non-cell selections
    return chainTransactions(splitCell, collapseSelection())(state, dispatch);
  };
}

/** True when the table has any real cross-row or cross-column merge. */
export function hasTableCellMerges(state: EditorState): boolean {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const seen = new Set<number>();
  for (let row = 0; row < rect.map.height; row += 1) {
    for (let col = 0; col < rect.map.width; col += 1) {
      const mapPos = rect.map.map[row * rect.map.width + col];
      if (seen.has(mapPos)) continue;
      seen.add(mapPos);
      const cell = state.doc.nodeAt(rect.tableStart + mapPos);
      if (cell && (cell.attrs.rowspan > 1 || cell.attrs.colspan > 1)) return true;
    }
  }
  return false;
}

/** True when unmerged cells still carry a reversible merge-group marker. */
export function hasRestorableMergeGroups(state: EditorState): boolean {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const seen = new Set<number>();
  for (let row = 0; row < rect.map.height; row += 1) {
    for (let col = 0; col < rect.map.width; col += 1) {
      const mapPos = rect.map.map[row * rect.map.width + col];
      if (seen.has(mapPos)) continue;
      seen.add(mapPos);
      if (state.doc.nodeAt(rect.tableStart + mapPos)?.attrs.mergeGroup) return true;
    }
  }
  return false;
}

/**
 * Auto-merge is available for any table under the caret. Cells that contain
 * nested tables are skipped when computing merges, but they no longer disable
 * the whole toolbar action.
 */
export function supportsDuplicateCellMerges(state: EditorState): boolean {
  return isInTable(state);
}

/** Backwards-compatible predicate for merges made by the duplicate toggle. */
export function hasDuplicateMergedCells(state: EditorState): boolean {
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  const seen = new Set<number>();
  for (let row = 0; row < rect.map.height; row += 1) {
    for (let col = 0; col < rect.map.width; col += 1) {
      const mapPos = rect.map.map[row * rect.map.width + col];
      if (seen.has(mapPos)) continue;
      seen.add(mapPos);
      if (state.doc.nodeAt(rect.tableStart + mapPos)?.attrs.duplicateMerged) return true;
    }
  }
  return false;
}

type DuplicateMergeSlot =
  | { type: 'original'; pos: number }
  | { type: 'replacement'; node: Node }
  | { type: 'skip' };

function containsNestedTable(cell: Node): boolean {
  let found = false;
  cell.descendants((child) => {
    if (child.type.name === 'table') {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function createSlots(map: TableMap, tableStart: number): DuplicateMergeSlot[][] {
  return Array.from({ length: map.height }, (_, row) =>
    Array.from({ length: map.width }, (_, col) => ({
      type: 'original' as const,
      pos: tableStart + map.map[row * map.width + col],
    }))
  );
}

interface MergeSpanOverride {
  rowspan: number;
  colspan: number;
  duplicateMerged: boolean;
  autoMerged: boolean;
  mergeGroup: string | null;
}

function rebuildTableFromSlots(
  table: Node,
  slots: DuplicateMergeSlot[][],
  stateDoc: Node,
  spanOverrides: Map<number, MergeSpanOverride> = new Map(),
): Node {
  const rows: Node[] = [];
  for (let rowIndex = 0; rowIndex < table.childCount; rowIndex += 1) {
    const originalRow = table.child(rowIndex);
    const cells: Node[] = [];
    let lastOriginalPos = -1;
    for (const slot of slots[rowIndex]) {
      if (slot.type === 'skip') continue;
      if (slot.type === 'replacement') {
        cells.push(slot.node);
        continue;
      }
      if (slot.pos === lastOriginalPos) continue;
      const original = stateDoc.nodeAt(slot.pos);
      if (!original) continue;
      const override = spanOverrides.get(slot.pos);
      cells.push(
        override === undefined
          ? original
          : original.type.create(
              { ...original.attrs, ...override },
              original.content,
              original.marks,
            ),
      );
      lastOriginalPos = slot.pos;
    }
    rows.push(originalRow.type.create(originalRow.attrs, cells, originalRow.marks));
  }
  return table.type.create(table.attrs, rows, table.marks);
}

function replaceCurrentTable(state: EditorState, table: Node, replacement: Node): Transaction {
  const rect = selectedRect(state);
  const from = rect.tableStart - 1;
  let tr = state.tr.replaceRangeWith(from, from + table.nodeSize, replacement);
  // Keep focus in the rebuilt table, avoiding a stale cell selection.
  const map = TableMap.get(replacement);
  const firstCellOffset = map.map[0];
  if (firstCellOffset == null) {
    return tr.scrollIntoView();
  }
  const $firstCell = tr.doc.resolve(from + 1 + firstCellOffset);
  return tr.setSelection(new CellSelection($firstCell)).scrollIntoView();
}

/**
 * Toggle automatic vertical merging of equal values in the current table.
 * Only consecutive, non-empty plain cells in the same column are merged.
 * Cells that contain nested tables are skipped. A selected state means the
 * table has actual merged cells; clicking it splits all of those cells.
 */
export function toggleDuplicateCellMerges(): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) return false;
    const rect = selectedRect(state);
    const { table, map } = rect;
    const tableStart = rect.tableStart;

    if (hasTableCellMerges(state)) {
      // Active toggle -> cancel every actual merge in this table. This covers
      // legacy auto merges as well as merges created by this button.
      if (!dispatch) return true;
      const slots = createSlots(map, tableStart);
      const seen = new Set<number>();
      for (let row = 0; row < map.height; row += 1) {
        for (let col = 0; col < map.width; col += 1) {
          const mapPos = map.map[row * map.width + col];
          if (seen.has(mapPos)) continue;
          seen.add(mapPos);
          const cell = state.doc.nodeAt(tableStart + mapPos);
          if (!cell || (cell.attrs.rowspan <= 1 && cell.attrs.colspan <= 1)) continue;
          const cellRect = map.findCell(mapPos);
          // Persist enough information to restore this exact merge on the next
          // click, even after save / close / reopen.
          const mergeGroup = [
            'evm', cellRect.top, cellRect.left, cellRect.bottom, cellRect.right,
            cell.attrs.autoMerged ? 1 : 0,
            cell.attrs.duplicateMerged ? 1 : 0,
          ].join(':');
          const clone = cell.type.create(
            {
              ...cell.attrs,
              rowspan: 1,
              colspan: 1,
              duplicateMerged: false,
              autoMerged: false,
              mergeGroup,
            },
            cell.content,
            cell.marks,
          );
          for (let r = cellRect.top; r < cellRect.bottom; r += 1) {
            for (let c = cellRect.left; c < cellRect.right; c += 1) {
              slots[r][c] = { type: 'replacement', node: clone };
            }
          }
        }
      }
      dispatch(replaceCurrentTable(state, table, rebuildTableFromSlots(table, slots, state.doc)));
      return true;
    }

    if (hasRestorableMergeGroups(state)) {
      if (!dispatch) return true;
      const slots = createSlots(map, tableStart);
      const groups = new Map<string, Array<{ row: number; col: number; pos: number }>>();
      const seen = new Set<number>();
      for (let row = 0; row < map.height; row += 1) {
        for (let col = 0; col < map.width; col += 1) {
          const mapPos = map.map[row * map.width + col];
          if (seen.has(mapPos)) continue;
          seen.add(mapPos);
          const cell = state.doc.nodeAt(tableStart + mapPos);
          const group = cell?.attrs.mergeGroup;
          if (!group) continue;
          const entries = groups.get(group) || [];
          entries.push({ row, col, pos: tableStart + mapPos });
          groups.set(group, entries);
        }
      }

      const spanOverrides = new Map<number, MergeSpanOverride>();
      for (const [group, entries] of groups) {
        const parts = group.split(':');
        if (parts.length !== 7 || parts[0] !== 'evm') continue;
        const top = Number(parts[1]);
        const left = Number(parts[2]);
        const bottom = Number(parts[3]);
        const right = Number(parts[4]);
        if (![top, left, bottom, right].every(Number.isFinite) || bottom <= top || right <= left) continue;
        const topLeft = entries.find((entry) => entry.row === top && entry.col === left);
        if (!topLeft) continue;
        spanOverrides.set(topLeft.pos, {
          rowspan: bottom - top,
          colspan: right - left,
          autoMerged: parts[5] === '1',
          duplicateMerged: parts[6] === '1',
          mergeGroup: null,
        });
        for (const entry of entries) {
          if (entry.pos !== topLeft.pos) slots[entry.row][entry.col] = { type: 'skip' };
        }
      }
      if (spanOverrides.size === 0) return false;
      dispatch(replaceCurrentTable(
        state,
        table,
        rebuildTableFromSlots(table, slots, state.doc, spanOverrides),
      ));
      return true;
    }

    if (!supportsDuplicateCellMerges(state)) return false;

    const slots = createSlots(map, tableStart);
    const spanOverrides = new Map<number, MergeSpanOverride>();
    let changed = false;

    for (let col = 0; col < map.width; col += 1) {
      let row = 0;
      while (row < map.height) {
        const mapPos = map.map[row * map.width + col];
        const cell = state.doc.nodeAt(tableStart + mapPos);
        if (!cell || cell.attrs.rowspan > 1 || cell.attrs.colspan > 1 || containsNestedTable(cell)) {
          row += Math.max(1, cell?.attrs.rowspan || 1);
          continue;
        }
        const text = cell.textContent.trim();
        if (!text) {
          row += 1;
          continue;
        }
        let end = row + 1;
        while (end < map.height) {
          const nextPos = map.map[end * map.width + col];
          if (nextPos === mapPos) break;
          const next = state.doc.nodeAt(tableStart + nextPos);
          if (!next || next.attrs.rowspan > 1 || next.attrs.colspan > 1 || containsNestedTable(next) || next.textContent.trim() !== text) break;
          end += 1;
        }
        if (end - row > 1) {
          spanOverrides.set(tableStart + mapPos, {
            rowspan: end - row,
            colspan: 1,
            duplicateMerged: true,
            autoMerged: false,
            mergeGroup: null,
          });
          for (let r = row + 1; r < end; r += 1) slots[r][col] = { type: 'skip' };
          changed = true;
        }
        row = end;
      }
    }

    if (changed && dispatch) {
      dispatch(replaceCurrentTable(state, table, rebuildTableFromSlots(table, slots, state.doc, spanOverrides)));
    }
    return true;
  };
}

/**
 * Helper function to add a row while copying alignment attributes from an existing row.
 *
 * @param tr The transaction
 * @param rect The table rect
 * @param index The index where to insert the row
 * @param copyFromRow The row index to copy alignment from (optional)
 * @param state The editor state
 * @returns The modified transaction
 */
function addRowWithAlignment(
  tr: Transaction,
  rect: TableRect,
  index: number,
  copyFromRow: number | undefined,
  state: EditorState
): Transaction {
  // Get alignment attributes from the source row BEFORE inserting the new row
  let sourceRowAlignments: (string | null)[] | undefined;

  if (
    copyFromRow !== undefined &&
    copyFromRow >= 0 &&
    copyFromRow < rect.map.height
  ) {
    const cellsInSourceRow = getCellsInRow(copyFromRow)(state);
    if (cellsInSourceRow) {
      sourceRowAlignments = cellsInSourceRow.map((pos) => {
        const node = tr.doc.nodeAt(pos);
        return node?.attrs.alignment || null;
      });
    }
  }

  // Now add the row using the standard prosemirror function
  const newTr = addRow(tr, rect, index);

  // Apply the copied alignments to the new row
  if (sourceRowAlignments) {
    const newState = state.apply(newTr);
    const cellsInNewRow = getCellsInRow(index)(newState);

    if (cellsInNewRow) {
      cellsInNewRow.forEach((newCellPos, colIndex) => {
        if (
          colIndex < sourceRowAlignments.length &&
          sourceRowAlignments[colIndex]
        ) {
          const newCellNode = newTr.doc.nodeAt(newCellPos);
          if (newCellNode) {
            const attrs = {
              ...newCellNode.attrs,
              alignment: sourceRowAlignments[colIndex],
            };
            newTr.setNodeMarkup(newCellPos, undefined, attrs);
          }
        }
      });
    }
  }

  return newTr;
}

/**
 * A command that deletes the entire table if all cells are selected.
 * Copied from Outline's shared/editor/commands/table.ts
 *
 * @returns The command
 */
export function deleteTableIfSelected(): Command {
  return (state, dispatch): boolean => {
    if (isTableSelected(state)) {
      return deleteTable(state, dispatch);
    }
    return false;
  };
}

// Export prosemirror-tables commands and utilities as-is
export { deleteRow, deleteColumn, deleteTable, mergeCells, splitCell, toggleHeader, moveTableRow, moveTableColumn, selectedRect, CellSelection };
