export { createXlsxAdapter, getXlsxWorkbook } from './adapter';
export { buildEmptyXlsxBytes } from './emptyWorkbook';
export { applySheetOp, rangeOpCells, type XlsxSheetOp } from './ops';
export {
  cellRef,
  columnLetter,
  columnNumber,
  parseCellRef,
  parseRange,
  refSortKey,
} from './refs';
export type { XlsxCell, XlsxCellValue } from './sheetXml';
export { XlsxWorkbook, type SheetInfo } from './workbook';

export const OOXML_XLSX_KIND = 'xlsx' as const;
