import type { XlsxTablePayload } from '@easyview/contracts';
import { buildXlsxFromTable } from '@easyview/ooxml-xlsx';

/**
 * Builds a real .xlsx workbook from the table payload produced by the editor.
 * Formatting intentionally mirrors the existing VS Code host implementation.
 */
export async function buildXlsxBuffer(payload: XlsxTablePayload): Promise<Buffer> {
  const bytes = await buildXlsxFromTable({
    cells: payload.cells.map((cell) => ({
      row: cell.row,
      col: cell.col,
      text: cell.text,
      alignment: cell.alignment,
      verticalAlignment: cell.verticalAlignment,
      isHeader: cell.isHeader,
    })),
    merges: payload.merges,
    columnWidths: payload.columnWidths,
    rowHeights: payload.rowHeights,
    totalCols: payload.totalCols,
    totalRows: payload.totalRows,
  });
  return Buffer.from(bytes);
}
