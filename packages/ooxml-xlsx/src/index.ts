export { createXlsxAdapter, getXlsxWorkbook } from './adapter';
export { buildEmptyXlsxBytes, EMPTY_SHEET_XML, sanitizeSheetName } from './emptyWorkbook';
export { buildXlsxFromTable, type TableExportPayload, type TableExportCell } from './tableExport';
export { applySheetOp, rangeOpCells, type XlsxSheetOp } from './ops';
export {
  cellRef,
  columnLetter,
  columnNumber,
  parseCellRef,
  parseRange,
  refSortKey,
} from './refs';
export type { XlsxCell, XlsxCellValue, SheetRowProps } from './sheetXml';
export {
  parseSheetCells,
  rewriteWorksheetXml,
  buildSheetDataXml,
} from './sheetXml';
export { parseSharedStrings } from './sharedStrings';
export { XlsxWorkbook, type SheetInfo } from './workbook';

export const OOXML_XLSX_KIND = 'xlsx' as const;
