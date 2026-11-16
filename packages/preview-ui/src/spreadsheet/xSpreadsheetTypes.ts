/**
 * Runtime data shape used by x-data-spreadsheet 1.x.
 *
 * The package's bundled declarations omit fields that its runtime reads and
 * writes (`rows.len`, row height without cells, font details, underline, etc.).
 * Keep that vendor mismatch at this boundary instead of spreading casts across
 * the preview implementation.
 */
export interface XsFont {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
}

export interface XsCellStyle {
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  font?: XsFont;
  bgcolor?: string;
  textwrap?: boolean;
  color?: string;
  strike?: boolean;
  underline?: boolean;
  /** x-spreadsheet number format key (normal, text, number, percent, rmb, usd, eur, date, …). */
  format?: string;
  border?: {
    top?: string[];
    right?: string[];
    bottom?: string[];
    left?: string[];
  };
}

export interface XsCell {
  text: string;
  style?: number;
  merge?: [number, number];
}

export interface XsRowData {
  height?: number;
  cells?: Record<number, XsCell>;
}

export interface XsRowsData {
  len: number;
  [rowIndex: number]: XsRowData;
}

export interface XsColumnData {
  width?: number;
}

export interface XsColumnsData {
  len: number;
  [columnIndex: number]: XsColumnData;
}

export interface XsSheetData {
  name?: string;
  freeze?: string;
  autofilter?: { ref?: string; filters?: unknown[]; sort?: unknown };
  styles?: XsCellStyle[];
  merges?: string[];
  cols?: XsColumnsData;
  rows?: XsRowsData;
  /** Excel sheet view zoomScale (percent). Stripped before the grid loads; not written by getData(). */
  zoom?: number;
  /** Default row height in CSS pixels. Stripped before the grid loads. */
  defaultRowPx?: number;
  /** Default column width in CSS pixels. Stripped before the grid loads. */
  defaultColPx?: number;
}

export interface XsStyleLike {
  bgcolor?: string;
  color?: string;
  [key: string]: unknown;
}

export interface XsDataLike {
  settings?: { style?: XsStyleLike };
  getCellStyleOrDefault?: (ri: number, ci: number) => XsStyleLike;
  getSelectedCellStyle?: () => XsStyleLike;
  selector?: { ri: number; ci: number };
}

export interface XsDrawLike {
  attr: (options: Record<string, unknown>) => unknown;
  text?: (text: string, box: unknown, attr?: Record<string, unknown>, wrap?: boolean) => unknown;
}

export interface XsCellRangeLike {
  sri: number;
  sci: number;
  eri: number;
  eci: number;
}

/** The parts of the active sheet's DataProxy that paste handling drives. */
export interface XsSheetDataLike {
  settings: { mode?: string };
  selector: { range: XsCellRangeLike };
  clipboard: { range: XsCellRangeLike | null; isClear(): boolean };
  rows: {
    len: number;
    getCell(ri: number, ci: number): { text?: unknown } | null;
    setCellText(ri: number, ci: number, text: string): void;
  };
  cols: { len: number };
  changeData(callback: () => void): void;
  clearClipboard(): void;
}

export interface XsSpreadsheetLike {
  reRender?: () => void;
  datas?: XsDataLike[];
  data?: XsDataLike;
  sheet?: {
    table?: { draw?: XsDrawLike; render?: () => void };
    /** Set by the library when the last click landed on the grid; gates its keyboard and paste handlers. */
    focusing?: boolean;
    data?: XsSheetDataLike;
    selector?: { hideClipboard(): void; resetAreaOffset?(): void };
    /** Full sheetReset: scrollbars, freeze, table paint, toolbar, selector. */
    reload?: () => void;
  };
}

export interface XsSpreadsheetInstance extends XsSpreadsheetLike {
  destroy(): void;
  loadData: (data: XsSheetData[]) => unknown;
  getData: () => XsSheetData[];
  change: (callback: () => void) => unknown;
}

export type XsSpreadsheetFactory = (
  container: HTMLElement,
  options?: Record<string, unknown>,
) => XsSpreadsheetInstance;
