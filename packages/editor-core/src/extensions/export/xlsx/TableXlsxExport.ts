import type { EditorRuntimeContext } from '../../../runtime/editorRuntimeContext';
/**
 * Table XLSX Export
 *
 * Builds a serializable representation of a ProseMirror table that mirrors the
 * on-page presentation (grid borders, merged cells, column widths, row heights)
 * and sends it to the owning host to build a real .xlsx workbook.
 */

import type { Command, EditorState } from "prosemirror-state";
import type { Node as ProsemirrorNode } from "prosemirror-model";
import { TableMap, isInTable, selectedRect } from "prosemirror-tables";
import type {
  XlsxTableCellPayload,
  XlsxTableMergePayload,
  XlsxTablePayload,
} from "@easyview/contracts";
import { cellContentToMarkdown } from "../../../editor/lib/MarkdownSerializer";

function containsNestedTable(cell: ProsemirrorNode): boolean {
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

/**
 * Build a serializable representation of the currently selected table that
 * mirrors the on-page presentation: grid borders, merged cells, column widths
 * and row heights. The selection must already be inside a table.
 */
export function buildTableXlsxPayload(state: EditorState): XlsxTablePayload {
  const rect = selectedRect(state);
  const tableNode = rect.table;
  const map = TableMap.get(tableNode);
  const tableStart = rect.tableStart;
  const width = map.width;
  const height = map.height;

  const cells: XlsxTableCellPayload[] = [];
  const merges: XlsxTableMergePayload[] = [];
  const columnWidths: (number | null)[] = new Array<number | null>(width).fill(null);
  const rowHeights: (number | null)[] = new Array<number | null>(height).fill(null);

  const seen = new Set<number>();

  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    const rowNode = tableNode.child(rowIndex);
    const rawHeight = rowNode?.attrs?.height;
    if (typeof rawHeight === 'number' && Number.isFinite(rawHeight) && rawHeight > 0) {
      rowHeights[rowIndex] = Math.round(rawHeight);
    }

    for (let colIndex = 0; colIndex < width; colIndex += 1) {
      const pos = map.map[rowIndex * width + colIndex];
      if (seen.has(pos)) continue;
      seen.add(pos);

      const cell = state.doc.nodeAt(tableStart + pos);
      if (!cell) continue;

      const cellRect = map.findCell(pos);
      const rowspan = cellRect.bottom - cellRect.top;
      const colspan = cellRect.right - cellRect.left;
      const colwidth = Array.isArray(cell.attrs.colwidth) ? cell.attrs.colwidth : null;

      cells.push({
        row: cellRect.top,
        col: cellRect.left,
        // Nested tables are exported as GFM pipe markdown so Excel keeps structure.
        text: containsNestedTable(cell) ? cellContentToMarkdown(cell) : cell.textContent,
        rowspan,
        colspan,
        isHeader: cell.type.name === 'table_header',
        alignment: typeof cell.attrs.alignment === 'string' ? cell.attrs.alignment : null,
        verticalAlignment:
          typeof cell.attrs.verticalAlignment === 'string' ? cell.attrs.verticalAlignment : null,
      });

      if (rowspan > 1 || colspan > 1) {
        merges.push({
          top: cellRect.top,
          left: cellRect.left,
          bottom: cellRect.bottom - 1,
          right: cellRect.right - 1,
        });
      }

      if (colwidth && colwidth.length === colspan) {
        for (let k = 0; k < colspan; k += 1) {
          const w = Number(colwidth[k]);
          if (Number.isFinite(w) && w > 0) {
            const target = cellRect.left + k;
            if (columnWidths[target] == null) columnWidths[target] = Math.round(w);
          }
        }
      }
    }
  }

  return {
    cells,
    merges,
    columnWidths,
    rowHeights,
    totalRows: height,
    totalCols: width,
  };
}

/**
 * Export the current table to a real Excel (.xlsx) workbook that preserves
 * the on-page presentation: grid borders, merged cells, column widths, row
 * heights and header styling.
 */
export function exportTableToXlsx({
  fileName,
  runtime,
}: {
  fileName: string;
  runtime: EditorRuntimeContext;
}): Command {
  return (state, dispatch) => {
    if (!isInTable(state)) {
      return false;
    }

    if (dispatch) {
      const payload = buildTableXlsxPayload(state);
      void runtime.host.postMessage({ type: 'exportXlsx', payload, fileName });
    }

    return true;
  };
}
