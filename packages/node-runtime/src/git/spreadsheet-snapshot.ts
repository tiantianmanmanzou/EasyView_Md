import { OpcPackage } from '@easyview/ooxml-core';
import { XlsxWorkbook, type XlsxCellValue } from '@easyview/ooxml-xlsx';
import type { SpreadsheetSheetSnapshot } from '@easyview/contracts';

export const SPREADSHEET_SNAPSHOT_MAX_BYTES = 20 * 1024 * 1024;
const MAX_SHEETS = 64;
const MAX_CELLS = 300_000;

export const isSpreadsheetSnapshotPath = (file: string): boolean => /\.(xlsx|xlsm)$/i.test(file);

function cellText(value: XlsxCellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return String(value);
}

/** Reads every worksheet's displayed cell texts. Throws when the workbook is unreadable or too large to compare. */
export async function readSpreadsheetSnapshot(bytes: Buffer): Promise<SpreadsheetSheetSnapshot[]> {
  if (bytes.byteLength > SPREADSHEET_SNAPSHOT_MAX_BYTES) throw new Error('Workbook is too large to compare.');
  const workbook = await XlsxWorkbook.open(await OpcPackage.open(bytes));
  if (workbook.sheets.length > MAX_SHEETS) throw new Error('Workbook has too many worksheets to compare.');
  const sheets: SpreadsheetSheetSnapshot[] = [];
  let cells = 0;
  for (const info of workbook.sheets) {
    const grid = await workbook.sheetGrid(info.name);
    const rowMap = new Map<number, Map<number, string>>();
    for (const [ref, value] of grid) {
      const text = cellText(value);
      if (!text) continue;
      if (++cells > MAX_CELLS) throw new Error('Workbook has too many cells to compare.');
      const match = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!match) continue;
      let col = 0;
      for (const ch of match[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = Number(match[2]);
      const line = rowMap.get(row) ?? new Map<number, string>();
      line.set(col, text);
      rowMap.set(row, line);
    }
    const maxRow = Math.max(0, ...rowMap.keys());
    const rows: string[][] = [];
    for (let r = 1; r <= maxRow; r += 1) {
      const line = rowMap.get(r);
      if (!line) continue;
      const maxCol = Math.max(0, ...line.keys());
      const values = Array.from({ length: maxCol }, (_, i) => line.get(i + 1) ?? '');
      rows[r - 1] = values;
    }
    sheets.push({ name: info.name, rows: Array.from(rows, (row) => row ?? []) });
  }
  return sheets;
}
