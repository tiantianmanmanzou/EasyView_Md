/**
 * Spreadsheet unit helpers + full-book load/save without ExcelJS.
 * ExcelJS-only decode helpers live in exceljsBridge.ts (tests / legacy parity).
 */

import JSZip from 'jszip';
import { buildEmptyXlsxBytes } from '@easyview/ooxml-xlsx';
import { tPreview } from '../preview.i18n';
import type { XsSheetData } from './xSpreadsheetTypes';

const DEFAULT_ROWS = 100;
const DEFAULT_COLS = 26;
/** Excel's widest column is 255 characters (~1785px at the default digit width). */
const MAX_COL_WIDTH_PX = 1790;
const MIN_COL_WIDTH_PX = 32;
/** Calibri 11 max digit width. OOXML column width is defined against this. */
const MAX_DIGIT_WIDTH = 7;

/** Excel character width → CSS pixels (ECMA-376, MDW = 7). */
export function excelColumnWidthToPx(width: number): number {
  const padding = Math.trunc(128 / MAX_DIGIT_WIDTH);
  const px = Math.trunc(((256 * width + padding) / 256) * MAX_DIGIT_WIDTH);
  return Math.min(MAX_COL_WIDTH_PX, Math.max(MIN_COL_WIDTH_PX, px));
}

/** Inverse of excelColumnWidthToPx, in Excel character units. */
export function pxToExcelColumnWidth(px: number): number {
  const padding = Math.trunc(128 / MAX_DIGIT_WIDTH);
  const approx = Math.max(0, Math.trunc(((px / MAX_DIGIT_WIDTH) * 256 - padding) / 256 * 100 + 0.5) / 100);
  const target = Math.round(px);
  const forward = (width: number) => Math.trunc(((256 * width + padding) / 256) * MAX_DIGIT_WIDTH);
  for (let step = 0; step <= 20; step += 1) {
    const probe = Math.round((approx + step / 100) * 100) / 100;
    if (forward(probe) === target) return probe;
  }
  return approx;
}

/** Excel row height is in points; the canvas uses CSS pixels at 96dpi. */
export function excelRowPointsToPx(points: number): number {
  return Math.max(1, Math.round((points * 96) / 72));
}

/** Inverse of excelRowPointsToPx, in points. */
export function pxToExcelRowPoints(px: number): number {
  return Math.round(((px * 72) / 96) * 100) / 100;
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

function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]]/g, '_').slice(0, 31).trim();
  return cleaned || 'Sheet1';
}

function parseA1Range(range: string): { sri: number; sci: number; eri: number; eci: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(range.trim());
  if (!match) return null;
  const col = (letters: string) => {
    let value = 0;
    for (const ch of letters.toUpperCase()) value = value * 26 + (ch.charCodeAt(0) - 64);
    return value - 1;
  };
  return {
    sci: col(match[1]),
    sri: Number(match[2]) - 1,
    eci: col(match[3]),
    eri: Number(match[4]) - 1,
  };
}

/** Check archive sizes and logical expansion before decoding worksheets. */
async function validateWorkbookBudget(bytes: ArrayBuffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  let expanded = 0;
  let sheets = 0;
  let cells = 0;
  let mergedCells = 0;
  const reject = () => {
    throw new Error(tPreview('spreadsheet.tooComplex'));
  };
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const size = (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize;
    if (!Number.isSafeInteger(size) || size < 0) reject();
    expanded += size;
    if (expanded > 128 * 1024 * 1024) reject();
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(entry.name)) continue;
    if (++sheets > 32 || size > 32 * 1024 * 1024) reject();
    const xml = await entry.async('string');
    const counts = validateSheetXml(xml);
    cells += counts.cells;
    mergedCells += counts.mergedCells;
    if (cells > 500_000 || mergedCells > 500_000) reject();
  }
}

/** Load workbook bytes into x-data-spreadsheet sheet payloads (ooxml decode). */
export async function workbookBytesToXsSheets(bytes: ArrayBuffer): Promise<XsSheetData[]> {
  await validateWorkbookBudget(bytes);
  const { LazyWorkbook } = await import('./lazyWorkbook');
  const book = await LazyWorkbook.open(bytes);
  const sheets: XsSheetData[] = [];
  for (let i = 0; i < book.sheets.length; i += 1) {
    sheets.push(await book.load(i));
  }
  return sheets.length > 0 ? sheets : [emptySheet('Sheet1')];
}

/** Serialize x-data-spreadsheet payloads back to xlsx bytes (ooxml / LazyWorkbook). */
export async function xsSheetsToWorkbookBytes(sheets: XsSheetData[]): Promise<Uint8Array> {
  const source = sheets.length > 0 ? sheets : [emptySheet('Sheet1')];
  const names = source.map((sheet) => sanitizeSheetName(sheet.name || 'Sheet1'));
  const seed = await buildEmptyXlsxBytes(names);
  const { LazyWorkbook } = await import('./lazyWorkbook');
  const book = await LazyWorkbook.open(seed.slice().buffer);
  const changes: Array<{ index: number; data: XsSheetData }> = [];
  for (let i = 0; i < source.length; i += 1) {
    await book.load(i);
    changes.push({ index: i, data: { ...source[i], name: names[i] } });
  }
  return book.save(changes);
}

/** Logical expansion is checked only when that worksheet is requested. */
export function validateSheetXml(xml: string): { cells: number; mergedCells: number } {
  let cells = 0;
  let mergedCells = 0;
  const reject = () => {
    throw new Error(tPreview('spreadsheet.tooComplex'));
  };
  for (const _ of xml.matchAll(/<c(?:\s|>)/g)) if (++cells > 500_000) reject();
  for (const match of xml.matchAll(/<mergeCell\b[^>]*\bref=["']([^"']+)["']/g)) {
    const range = parseA1Range(match[1]);
    if (!range) reject();
    mergedCells += (range!.eri - range!.sri + 1) * (range!.eci - range!.sci + 1);
    if (mergedCells > 500_000) reject();
  }
  return { cells, mergedCells };
}
