/**
 * Shared payload between the EasyView webview and the VS Code host for
 * exporting a ProseMirror table to a real .xlsx workbook that mirrors the
 * on-page formatting (grid borders, merged cells, column widths, row heights).
 */

export interface XlsxTableCellPayload {
  /** 0-based grid row of the cell's top-left corner */
  row: number;
  /** 0-based grid column of the cell's top-left corner */
  col: number;
  /** Plain text content of the cell */
  text: string;
  /** Number of grid rows spanned (>= 1) */
  rowspan: number;
  /** Number of grid columns spanned (>= 1) */
  colspan: number;
  /** Whether this cell is a header cell (rendered bold on the page) */
  isHeader: boolean;
  /** CSS text-align value, e.g. 'left' | 'center' | 'right' | 'justify' */
  alignment: string | null;
  /** CSS vertical-align value, e.g. 'top' | 'middle' | 'bottom' */
  verticalAlignment: string | null;
}

export interface XlsxTableMergePayload {
  /** 0-based inclusive top row */
  top: number;
  /** 0-based inclusive left column */
  left: number;
  /** 0-based inclusive bottom row */
  bottom: number;
  /** 0-based inclusive right column */
  right: number;
}

export interface XlsxTablePayload {
  cells: XlsxTableCellPayload[];
  merges: XlsxTableMergePayload[];
  /** Per grid column pixel width, or null if not set on the page */
  columnWidths: (number | null)[];
  /** Per grid row pixel height, or null if not set on the page */
  rowHeights: (number | null)[];
  totalRows: number;
  totalCols: number;
}
