/**
 * ExcelJS-backed sheet decode helpers for tests and parity checks.
 * Production load/save uses LazyWorkbook + ooxml (xSpreadsheetBridge).
 */

import ExcelJS from 'exceljs';
import type { XsCell, XsCellStyle, XsColumnsData, XsRowsData, XsSheetData } from './xSpreadsheetTypes';
import { isThemeableBackground, isThemeableForeground } from './spreadsheetTheme';
import { formatExcelDate } from './excelDateFormat';
import {
  excelColumnWidthToPx,
  excelRowPointsToPx,
  pxToExcelColumnWidth,
  pxToExcelRowPoints,
} from './xSpreadsheetBridge';

type XsStyle = XsCellStyle;

const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;

export function worksheetToXsSheet(worksheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook): XsSheetData {
  const styles: XsStyle[] = [];
  const styleIndex = new Map<string, number>();
  const rowCount = Math.max(DEFAULT_ROWS, worksheet.rowCount || 0);
  const colCount = Math.max(DEFAULT_COLS, worksheet.columnCount || 0);
  const rows: NonNullable<XsSheetData['rows']> = { len: rowCount };
  const cols: NonNullable<XsSheetData['cols']> = { len: colCount };
  const mergeRanges = (worksheet.model.merges || []).map(String);
  const merges: string[] = [];
  for (const range of mergeRanges) if (parseA1Range(range)) merges.push(range);

  (worksheet.columns ?? []).forEach((column, index) => {
    if (column && typeof column.width === 'number' && column.width > 0) {
      cols[index] = { width: excelColumnWidthToPx(column.width) };
    }
  });

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const ri = rowNumber - 1;
    if (typeof row.height === 'number' && row.height > 0) {
      rows[ri] = rows[ri] || { cells: {} };
      (rows[ri] as { height?: number }).height = excelRowPointsToPx(row.height);
    }

    const cells: Record<number, XsCell> = {};
    // includeEmpty: empty cells still carry borders / fills from Excel; skipping them
    // drops the grid lines the source file shows around blank cells.
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const ci = colNumber - 1;
      // ExcelJS owns merge membership; do not materialize a second coordinate set.
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) return;

      const text = cellToText(cell);
      const styleKey = styleKeyFor(cell, workbook);
      let style: number | undefined;
      if (styleKey) {
        const existing = styleIndex.get(styleKey);
        if (existing !== undefined) style = existing;
        else {
          style = styles.length;
          styles.push(cellToXsStyle(cell, workbook));
          styleIndex.set(styleKey, style);
        }
      }
      if (!text && style === undefined) return;
      cells[ci] = style === undefined ? { text } : { text, style };
    });

    if (Object.keys(cells).length > 0) {
      rows[ri] = { ...rows[ri], cells: { ...(rows[ri] as { cells?: Record<number, XsCell> } | undefined)?.cells, ...cells } };
    }
  });

  for (const range of merges) {
    const parsed = parseA1Range(range);
    if (!parsed) continue;
    const { sri, sci, eri, eci } = parsed;
    const row = (rows[sri] as { cells?: Record<number, XsCell> } | undefined) || { cells: {} };
    const cell = row.cells?.[sci] || { text: '' };
    cell.merge = [eri - sri, eci - sci];
    row.cells = { ...row.cells, [sci]: cell };
    rows[sri] = row;
  }

  const view = (worksheet.views || [])[0] as { state?: string; xSplit?: number; ySplit?: number; zoomScale?: number } | undefined;
  const freeze = view?.state === 'frozen' && ((view.xSplit ?? 0) > 0 || (view.ySplit ?? 0) > 0)
    ? `${columnLetters(view.xSplit ?? 0)}${(view.ySplit ?? 0) + 1}`
    : undefined;
  // Excel often stores autoFilter as the header row only (e.g. A2:K2); the grid then
  // finds no values under the header and shows "0 / 0". Expand to the last data row.
  const filterRef = expandAutoFilterRef(autoFilterRefOf(worksheet), rows);
  const zoom = typeof view?.zoomScale === 'number' && view.zoomScale >= 10 && view.zoomScale <= 400
    ? Math.round(view.zoomScale)
    : undefined;
  const props = worksheet.properties;
  const defaultRowPx = typeof props?.defaultRowHeight === 'number' && props.defaultRowHeight > 0
    ? excelRowPointsToPx(props.defaultRowHeight)
    : undefined;
  const defaultColPx = typeof props?.defaultColWidth === 'number' && props.defaultColWidth > 0
    ? excelColumnWidthToPx(props.defaultColWidth)
    : undefined;

  return {
    name: worksheet.name,
    ...(freeze ? { freeze } : {}),
    ...(filterRef ? { autofilter: { ref: filterRef, filters: [] } } : {}),
    ...(zoom ? { zoom } : {}),
    ...(defaultRowPx ? { defaultRowPx } : {}),
    ...(defaultColPx ? { defaultColPx } : {}),
    styles,
    merges,
    cols,
    rows,
  };
}

function applyXsSheetToWorksheet(sheet: XsSheetData, worksheet: ExcelJS.Worksheet): void {
  const styles = sheet.styles || [];
  const rows: XsRowsData = sheet.rows ?? { len: 0 };
  const cols: XsColumnsData = sheet.cols ?? { len: DEFAULT_COLS };
  const maxRow = typeof rows.len === 'number'
    ? rows.len
    : Math.max(0, ...Object.keys(rows).map(Number).filter((n) => Number.isFinite(n))) + 1;
  const colIndexes = Object.keys(cols).map(Number).filter((n) => Number.isFinite(n));
  const maxCol = typeof cols.len === 'number'
    ? cols.len
    : Math.max(DEFAULT_COLS, ...(colIndexes.length ? colIndexes.map((n) => n + 1) : [DEFAULT_COLS]));

  for (let ci = 0; ci < maxCol; ci += 1) {
    const col = cols[ci] as { width?: number } | undefined;
    if (col?.width) worksheet.getColumn(ci + 1).width = Math.max(0, pxToExcelColumnWidth(col.width));
  }

  for (let ri = 0; ri < maxRow; ri += 1) {
    const rowData = rows[ri] as { cells?: Record<number, XsCell>; height?: number } | undefined;
    if (!rowData) continue;
    const row = worksheet.getRow(ri + 1);
    if (typeof rowData.height === 'number' && rowData.height > 0) row.height = pxToExcelRowPoints(rowData.height);
    const cells = rowData.cells || {};
    for (const [ciText, cellData] of Object.entries(cells)) {
      const ci = Number(ciText);
      if (!Number.isFinite(ci) || !cellData) continue;
      const cell = row.getCell(ci + 1);
      cell.value = cellData.text ?? '';
      const style = typeof cellData.style === 'number' ? styles[cellData.style] : undefined;
      if (style) applyXsStyleToCell(style, cell);
    }
    row.commit();
  }

  for (const merge of sheet.merges || []) {
    try {
      worksheet.mergeCells(merge);
    } catch {
      // Ignore invalid merge ranges from the editor model.
    }
  }
}

function cellToText(cell: ExcelJS.Cell): string {
  try {
    const value = cell.value;
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return formatExcelDate(value, cell.numFmt);
    if (typeof value === 'object') {
      const rich = value as {
        richText?: Array<{ text?: unknown }>;
        text?: unknown;
        result?: unknown;
        formula?: string;
        sharedFormula?: string;
        hyperlink?: string;
        error?: string;
      };
      if (Array.isArray(rich.richText)) {
        return rich.richText.map((part) => flattenText(part?.text)).join('');
      }
      if (rich.text != null) return flattenText(rich.text);
      if (rich.result instanceof Date) return formatExcelDate(rich.result, cell.numFmt);
      if (rich.result != null) return flattenText(rich.result);
      if (typeof rich.error === 'string') return rich.error;
      if (typeof rich.formula === 'string') return `=${rich.formula}`;
      if (typeof rich.sharedFormula === 'string') return `=${rich.sharedFormula}`;
      if (typeof rich.hyperlink === 'string') return rich.hyperlink;
    }
    // Avoid ExcelJS MergeValue.toString() which can throw on null.
    if (cell.isMerged && cell.master && cell.master !== cell) return '';
    const fallback = cell.text;
    return typeof fallback === 'string' && fallback !== '[object Object]' ? fallback : '';
  } catch {
    return '';
  }
}

function flattenText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((part) => flattenText(part)).join('');
  if (typeof value === 'object' && value && 'text' in value) return flattenText((value as { text?: unknown }).text);
  return '';
}

function cellToXsStyle(cell: ExcelJS.Cell, workbook: ExcelJS.Workbook): XsStyle {
  const font = cell.font || {};
  const alignment = cell.alignment || {};
  const fill = cell.fill as ExcelJS.FillPattern | undefined;
  const style: XsStyle = {};
  if (font.bold || font.italic || font.size || font.name || font.color || font.strike || font.underline) {
    // Omit unknown size/name instead of setting them to undefined: x-spreadsheet's style merge copies
    // undefined over its defaultStyle font, which leaves the canvas without a font size and the text
    // undrawn (e.g. a bold-only header row rendered empty).
    style.font = { bold: !!font.bold, italic: !!font.italic };
    if (typeof font.size === 'number') style.font.size = font.size;
    if (typeof font.name === 'string') style.font.name = font.name;
    const color = colorToCss(font.color, workbook);
    // Leave near-black to x-spreadsheet defaultStyle so EasyView themes can retint body text.
    if (color && !isThemeableForeground(color)) style.color = color;
  }
  if (font.strike) style.strike = true;
  if (font.underline) style.underline = true;
  if (alignment.horizontal === 'left' || alignment.horizontal === 'center' || alignment.horizontal === 'right') {
    style.align = alignment.horizontal;
  }
  if (alignment.vertical === 'top' || alignment.vertical === 'middle' || alignment.vertical === 'bottom') {
    style.valign = alignment.vertical;
  }
  if (alignment.wrapText) style.textwrap = true;
  const border = cellBorderToXs(cell.border);
  if (border) style.border = border;
  const format = numFmtToXsFormat(cell.numFmt);
  if (format) style.format = format;
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const bg = colorToCss(fill.fgColor, workbook) || colorToCss(fill.bgColor, workbook);
    // Leave near-white fills to defaultStyle so theme surface can follow EasyView palette.
    if (bg && !isThemeableBackground(bg)) style.bgcolor = bg;
  }
  return style;
}

export function applyXsStyleToCell(style: XsStyle, cell: ExcelJS.Cell): void {
  if (style.font || style.color || style.strike || style.underline) {
    cell.font = {
      ...cell.font,
      bold: style.font?.bold,
      italic: !!(style.font as { italic?: boolean } | undefined)?.italic,
      size: style.font?.size,
      name: style.font?.name,
      strike: style.strike,
      underline: style.underline,
      color: style.color ? { argb: cssToArgb(style.color) } : undefined,
    };
  }
  if (style.align || style.valign || style.textwrap) {
    cell.alignment = {
      ...cell.alignment,
      horizontal: style.align,
      vertical: style.valign,
      wrapText: style.textwrap,
    };
  }
  if (style.border) cell.border = xsBorderToCell(style.border);
  if (style.format && style.format in XS_NUMBER_FORMATS) cell.numFmt = XS_NUMBER_FORMATS[style.format];
  if (style.bgcolor) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: cssToArgb(style.bgcolor) },
    };
  }
}

/** x-spreadsheet number-format keys ↔ Excel format codes (the editor's "Normal ▾" menu). */
const XS_NUMBER_FORMATS: Record<string, string> = {
  normal: 'General',
  text: '@',
  number: '#,##0.00',
  percent: '0.00%',
  rmb: '"￥"#,##0.00',
  usd: '"$"#,##0.00',
  eur: '"€"#,##0.00',
  date: 'yyyy-mm-dd',
  time: 'hh:mm:ss',
  datetime: 'yyyy-mm-dd hh:mm:ss',
  duration: '[h]:mm:ss',
};

function numFmtToXsFormat(numFmt: string | undefined): string | undefined {
  if (!numFmt || numFmt === 'General') return undefined;
  return Object.entries(XS_NUMBER_FORMATS).find(([, code]) => code === numFmt)?.[0];
}

type XsBorder = NonNullable<XsStyle['border']>;
const XS_BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;
const XS_LINE_STYLES = new Set(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double']);

function cellBorderToXs(border: Partial<ExcelJS.Borders> | undefined): XsBorder | undefined {
  if (!border) return undefined;
  const out: XsBorder = {};
  for (const side of XS_BORDER_SIDES) {
    const edge = border[side];
    if (!edge?.style) continue;
    const argb = (edge.color as { argb?: string } | undefined)?.argb;
    const color = typeof argb === 'string' ? `#${(argb.length === 8 ? argb.slice(2) : argb).toLowerCase()}` : '#000000';
    out[side] = [XS_LINE_STYLES.has(edge.style) ? edge.style : 'thin', color];
  }
  return Object.keys(out).length ? out : undefined;
}

function xsBorderToCell(border: XsBorder): Partial<ExcelJS.Borders> {
  const out: Partial<ExcelJS.Borders> = {};
  for (const side of XS_BORDER_SIDES) {
    const edge = border[side];
    if (!edge?.[0]) continue;
    out[side] = { style: edge[0] as ExcelJS.BorderStyle, color: { argb: cssToArgb(edge[1] || '#000000') } };
  }
  return out;
}

function columnLetters(index: number): string {
  let n = index + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

function styleKeyFor(cell: ExcelJS.Cell, workbook: ExcelJS.Workbook): string | null {
  const style = cellToXsStyle(cell, workbook);
  if (Object.keys(style).length === 0) return null;
  return JSON.stringify(style);
}

/** Office default theme palette (lt1/dk1/lt2/dk2/accents…) used when only theme index is present. */
const OFFICE_THEME_RGB = [
  'ffffff', // 0 lt1
  '000000', // 1 dk1
  'e7e6e6', // 2 lt2
  '44546a', // 3 dk2
  '5b9bd5', // 4 accent1
  'ed7d31', // 5 accent2
  'a5a5a5', // 6 accent3
  'ffc000', // 7 accent4
  '4472c4', // 8 accent5
  '70ad47', // 9 accent6
];

function colorToCss(
  color: (Partial<ExcelJS.Color> & { tint?: number }) | undefined,
  _workbook: ExcelJS.Workbook,
): string | undefined {
  if (!color) return undefined;
  if (typeof color.argb === 'string') {
    const hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb;
    if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toLowerCase()}`;
  }
  if (typeof color.theme === 'number' && color.theme >= 0 && color.theme < OFFICE_THEME_RGB.length) {
    return applyTint(`#${OFFICE_THEME_RGB[color.theme]}`, typeof color.tint === 'number' ? color.tint : 0);
  }
  return undefined;
}

function applyTint(cssHex: string, tint: number): string {
  if (!tint) return cssHex;
  const hex = cssHex.replace('#', '');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const channel = (c: number) => {
    const next = tint < 0 ? c * (1 + tint) : c + (255 - c) * tint;
    return Math.max(0, Math.min(255, Math.round(next)));
  };
  return `#${[channel(r), channel(g), channel(b)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function cssToArgb(css: string): string {
  let hex = css.replace('#', '').trim();
  if (/^[0-9a-fA-F]{3}$/.test(hex)) hex = hex.replace(/./g, (ch) => ch + ch);
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `FF${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{8}$/.test(hex)) return hex.toUpperCase();
  return 'FF000000';
}

function parseA1Range(range: string): { sri: number; sci: number; eri: number; eci: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range.trim());
  if (!match) return null;
  return {
    sci: colLettersToIndex(match[1]),
    sri: Number(match[2]) - 1,
    eci: colLettersToIndex(match[3]),
    eri: Number(match[4]) - 1,
  };
}

/** ExcelJS may expose autoFilter as a string or as { from, to }. */
function autoFilterRefOf(worksheet: ExcelJS.Worksheet): string | undefined {
  const filter = worksheet.autoFilter as unknown;
  if (typeof filter === 'string' && filter.trim()) return filter.trim();
  if (!filter || typeof filter !== 'object') return undefined;
  const { from, to } = filter as {
    from?: { row?: number; column?: number };
    to?: { row?: number; column?: number };
  };
  if (!(from?.row && from.column && to?.row && to.column)) return undefined;
  return `${columnLetters(from.column - 1)}${from.row}:${columnLetters(to.column - 1)}${to.row}`;
}

/**
 * Grow a header-only (or short) autoFilter ref down to the last non-empty cell in its
 * columns so the filter menu can list the column's values.
 */
function expandAutoFilterRef(ref: string | undefined, rows: NonNullable<XsSheetData['rows']>): string | undefined {
  if (!ref) return undefined;
  const parsed = parseA1Range(ref);
  if (!parsed) return ref;
  const { sri, sci, eri, eci } = parsed;
  let last = eri;
  for (const [key, row] of Object.entries(rows)) {
    if (key === 'len') continue;
    const ri = Number(key);
    if (!Number.isFinite(ri) || ri <= sri) continue;
    const cells = (row as { cells?: Record<number, XsCell> } | undefined)?.cells;
    if (!cells) continue;
    for (let ci = sci; ci <= eci; ci += 1) {
      const text = cells[ci]?.text;
      if (typeof text === 'string' && text.trim() !== '') {
        last = Math.max(last, ri);
        break;
      }
    }
  }
  if (last === eri) return ref;
  return `${columnLetters(sci)}${sri + 1}:${columnLetters(eci)}${last + 1}`;
}

function colLettersToIndex(letters: string): number {
  let value = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i += 1) {
    value = value * 26 + (upper.charCodeAt(i) - 64);
  }
  return value - 1;
}

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]]/g, '_').slice(0, 31).trim();
  return cleaned || 'Sheet1';
}
