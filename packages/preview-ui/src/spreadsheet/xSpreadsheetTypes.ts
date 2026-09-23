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
  styles?: XsCellStyle[];
  merges?: string[];
  cols?: XsColumnsData;
  rows?: XsRowsData;
}

export interface XsStyleLike {
  bgcolor?: string;
  color?: string;
  [key: string]: unknown;
}

export interface XsDataLike {
  settings?: { style?: XsStyleLike };
  getCellStyleOrDefault?: (ri: number, ci: number) => XsStyleLike;
}

export interface XsDrawLike {
  attr: (options: Record<string, unknown>) => unknown;
}

export interface XsSpreadsheetLike {
  reRender?: () => void;
  datas?: XsDataLike[];
  data?: XsDataLike;
  sheet?: { table?: { draw?: XsDrawLike; render?: () => void } };
}

export interface XsSpreadsheetInstance extends XsSpreadsheetLike {
  loadData: (data: XsSheetData[]) => unknown;
  getData: () => XsSheetData[];
  change: (callback: () => void) => unknown;
}

export type XsSpreadsheetFactory = (
  container: HTMLElement,
  options?: Record<string, unknown>,
) => XsSpreadsheetInstance;
