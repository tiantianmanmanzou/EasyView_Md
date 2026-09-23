import ExcelJS from 'exceljs';
import type { XsCell, XsCellStyle, XsColumnsData, XsRowsData, XsSheetData } from './xSpreadsheetTypes';
import { isThemeableBackground, isThemeableForeground } from './spreadsheetTheme';

type XsStyle = XsCellStyle;

const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;
const MAX_COL_WIDTH_PX = 480;
const MIN_COL_WIDTH_PX = 32;

/** Load workbook bytes into x-data-spreadsheet sheet payloads. */
export async function workbookBytesToXsSheets(bytes: ArrayBuffer): Promise<XsSheetData[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheets: XsSheetData[] = [];
  workbook.eachSheet((worksheet) => {
    sheets.push(worksheetToXsSheet(worksheet, workbook));
  });
  return sheets.length > 0 ? sheets : [emptySheet('Sheet1')];
}

/** Serialize x-data-spreadsheet payloads back to xlsx bytes. */
export async function xsSheetsToWorkbookBytes(sheets: XsSheetData[]): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const source = sheets.length > 0 ? sheets : [emptySheet('Sheet1')];
  for (const sheet of source) {
    const name = sanitizeSheetName(sheet.name || `Sheet${workbook.worksheets.length + 1}`);
    const worksheet = workbook.addWorksheet(name);
    applyXsSheetToWorksheet(sheet, worksheet);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

function emptySheet(name: string): XsSheetData {
  return {
    name,
    styles: [],
    merges: [],
    cols: { len: DEFAULT_COLS },
    rows: { len: DEFAULT_ROWS },
  };
}

function worksheetToXsSheet(worksheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook): XsSheetData {
  const styles: XsStyle[] = [];
  const styleIndex = new Map<string, number>();
  const rowCount = Math.max(DEFAULT_ROWS, worksheet.rowCount || 0);
  const colCount = Math.max(DEFAULT_COLS, worksheet.columnCount || 0);
  const rows: NonNullable<XsSheetData['rows']> = { len: rowCount };
  const cols: NonNullable<XsSheetData['cols']> = { len: colCount };
  const mergeRanges = (worksheet.model.merges || []).map(String);
  const merges: string[] = [];
  const slaveCells = new Set<string>();

  for (const range of mergeRanges) {
    const parsed = parseA1Range(range);
    if (!parsed) continue;
    merges.push(range);
    const { sri, sci, eri, eci } = parsed;
    for (let ri = sri; ri <= eri; ri += 1) {
      for (let ci = sci; ci <= eci; ci += 1) {
        if (ri === sri && ci === sci) continue;
        slaveCells.add(`${ri},${ci}`);
      }
    }
  }

  worksheet.columns.forEach((column, index) => {
    if (column && typeof column.width === 'number' && column.width > 0) {
      const px = Math.round(column.width * 8);
      cols[index] = { width: Math.min(MAX_COL_WIDTH_PX, Math.max(MIN_COL_WIDTH_PX, px)) };
    }
  });

  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const ri = rowNumber - 1;
    if (typeof row.height === 'number' && row.height > 0) {
      rows[ri] = rows[ri] || { cells: {} };
      (rows[ri] as { height?: number }).height = Math.round(row.height);
    }

    const cells: Record<number, XsCell> = {};
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const ci = colNumber - 1;
      if (slaveCells.has(`${ri},${ci}`)) return;
      // Skip pure merge-slave typed cells even if merge list was incomplete.
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

  return {
    name: worksheet.name,
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
    if (col?.width) worksheet.getColumn(ci + 1).width = Math.max(4, col.width / 8);
  }

  for (let ri = 0; ri < maxRow; ri += 1) {
    const rowData = rows[ri] as { cells?: Record<number, XsCell>; height?: number } | undefined;
    if (!rowData) continue;
    const row = worksheet.getRow(ri + 1);
    if (typeof rowData.height === 'number' && rowData.height > 0) row.height = rowData.height;
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
    if (value instanceof Date) return value.toISOString();
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
    style.font = {
      bold: !!font.bold,
      italic: !!font.italic,
      size: typeof font.size === 'number' ? font.size : undefined,
      name: typeof font.name === 'string' ? font.name : undefined,
    };
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
  if (fill?.type === 'pattern' && fill.pattern !== 'none') {
    const bg = colorToCss(fill.fgColor, workbook) || colorToCss(fill.bgColor, workbook);
    // Leave near-white fills to defaultStyle so theme surface can follow EasyView palette.
    if (bg && !isThemeableBackground(bg)) style.bgcolor = bg;
  }
  return style;
}

function applyXsStyleToCell(style: XsStyle, cell: ExcelJS.Cell): void {
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
  if (style.bgcolor) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: cssToArgb(style.bgcolor) },
    };
  }
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
  const hex = css.replace('#', '').trim();
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
