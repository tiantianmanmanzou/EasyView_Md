/**
 * Table Commands
 *
 * ProseMirror commands for table operations.
 * Copied from Outline's shared/editor/commands/table.ts
 */

import type { Node, NodeType } from "prosemirror-model";
import type { Command, EditorState, Transaction } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import {
  CellSelection,
  TableMap,
  addRow,
  isInTable,
  selectedRect,
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

  const createCell = (cellType: NodeType, attrs: Record<string, any> | null) =>
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
        null,
        withHeaderRow && index === 0 ? headerCells : cells
      )
    );
  }

  return types.table.createChecked(null, rows);
}

/**
 * Detect CSV delimiter based on locale
 * In some regions (Russia, Germany, France, etc.) semicolon is used as CSV delimiter
 * because comma is used as decimal separator
 */
function getCSVDelimiter(): string {
  // Get user setting (set by extension in provider.ts)
  const setting = (window as any).csvDelimiterSetting || 'auto';

  // If user explicitly chose a delimiter, use it
  if (setting === ',') return ',';
  if (setting === ';') return ';';

  // Auto-detect based on system locale
  const systemLocale = (window as any).systemLocale;
  const locale = systemLocale || navigator.language || navigator.languages?.[0] || 'en-US';

  // Normalize locale (e.g., "ru-RU" -> "ru", "en-US" -> "en")
  const lang = locale.toLowerCase().split('-')[0];

  // List of languages that use semicolon as CSV delimiter
  // (because they use comma as decimal separator)
  const semicolonLanguages = [
    'ru', // Russian - Русский
    'de', // German - Deutsch
    'fr', // French - Français
    'it', // Italian - Italiano
    'es', // Spanish - Español
    'pt', // Portuguese - Português
    'pl', // Polish - Polski
    'nl', // Dutch - Nederlands
    'cs', // Czech - Čeština
    'sk', // Slovak - Slovenčina
    'ro', // Romanian - Română
    'hu', // Hungarian - Magyar
    'tr', // Turkish - Türkçe
    'sv', // Swedish - Svenska
    'no', // Norwegian - Norsk
    'da', // Danish - Dansk
    'fi', // Finnish - Suomi
  ];

  const delimiter = semicolonLanguages.includes(lang) ? ';' : ',';

  return delimiter;
}

/**
 * Export table to CSV file
 */
export function exportTable({
  fileName,
}: {
  format: string;
  fileName: string;
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

      // Detect appropriate CSV delimiter based on locale
      const delimiter = getCSVDelimiter();

      const csv = table
        .map((row) =>
          row
            .map((cell) => {
              let value = cell.textContent;

              // Escape double quotes by doubling them
              if (value.includes('"')) {
                value = value.replace(new RegExp('"', "g"), '""');
              }

              // Avoid cell content being interpreted as formulas by adding a leading single quote
              if (value.startsWith('=') || value.startsWith('+') || value.startsWith('-') || value.startsWith('@')) {
                value = "'" + value;
              }

              return `"${value}"`;
            })
            .join(delimiter)
        )
        .join("\n");

      // Send CSV data to VS Code host for save dialog + notification
      const vscodeApi = (window as any).__vscodeApi;
      if (vscodeApi) {
        vscodeApi.postMessage({ type: 'exportCsv', data: csv, fileName });
      }
    }

    return true;
  };
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
export function setColumnAttr({
  index,
  alignment,
}: {
  index: number;
  alignment: string;
}): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const cells = getCellsInColumn(index)(state) || [];
      let transaction = state.tr;
      cells.forEach((pos) => {
        const node = state.doc.nodeAt(pos);
        transaction = transaction.setNodeMarkup(pos, undefined, {
          ...node?.attrs,
          alignment,
        });
      });
      dispatch(transaction);
    }
    return true;
  };
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
  rect: any,
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
