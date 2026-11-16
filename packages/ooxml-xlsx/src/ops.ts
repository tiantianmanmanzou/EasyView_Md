/** Apply AI/manual sheet ops against an XlsxWorkbook model. */

import { cellRef, columnLetter, columnNumber, parseRange } from './refs';
import type { XlsxCellValue } from './sheetXml';
import type { XlsxWorkbook } from './workbook';

export type XlsxSheetOp =
  | {
      op: 'setCell';
      sheet: string;
      ref: string;
      value?: XlsxCellValue;
      formula?: string;
    }
  | {
      op: 'setRange';
      sheet: string;
      range: string;
      value?: XlsxCellValue;
      values?: XlsxCellValue[][];
      formula?: string;
    }
  | {
      op: 'transformRange';
      sheet: string;
      range: string;
      transform: 'multiply' | 'add' | 'round' | 'replaceText' | 'prefix' | 'suffix' | 'clear';
      number?: number;
      digits?: number;
      find?: string;
      text?: string;
    }
  | {
      op: 'replaceWhere';
      sheet: string;
      matchColumn: string;
      equals: XlsxCellValue;
      setColumn: string;
      value?: XlsxCellValue;
      formula?: string;
      fromRow?: number;
      toRow?: number;
    }
  | {
      op: 'insertRows';
      sheet: string;
      at: number;
      rows: XlsxCellValue[][];
    }
  | {
      op: 'deleteRows';
      sheet: string;
      at: number;
      count: number;
    }
  | {
      op: 'setStyle';
      sheet: string;
      ref: string;
      bold?: boolean;
      italic?: boolean;
      fillColor?: string;
      numFmt?: string;
    }
  | {
      op: 'addSheet';
      name: string;
    }
  | {
      op: 'deleteSheet';
      sheet: string;
    }
  | {
      op: 'renameSheet';
      sheet: string;
      newName: string;
    };

function fillFormula(formula: string, row: number, col: number): string {
  return formula.replace(/^=/, '').replace(/\{row\}/g, String(row)).replace(/\{col\}/g, columnLetter(col));
}

function transformValue(
  value: XlsxCellValue,
  op: Extract<XlsxSheetOp, { op: 'transformRange' }>,
): XlsxCellValue {
  switch (op.transform) {
    case 'clear':
      return null;
    case 'multiply':
      return typeof value === 'number' ? value * (op.number ?? 1) : value;
    case 'add':
      return typeof value === 'number' ? value + (op.number ?? 0) : value;
    case 'round': {
      if (typeof value !== 'number') return value;
      const factor = 10 ** (op.digits ?? 0);
      return Math.round(value * factor) / factor;
    }
    case 'replaceText':
      return typeof value === 'string' ? value.split(op.find ?? '').join(op.text ?? '') : value;
    case 'prefix':
      return typeof value === 'string' || typeof value === 'number' ? `${op.text ?? ''}${value}` : value;
    case 'suffix':
      return typeof value === 'string' || typeof value === 'number' ? `${value}${op.text ?? ''}` : value;
  }
}

/** Cells a range op will touch; used to enforce caps before work. */
export function rangeOpCells(op: XlsxSheetOp): number {
  if (op.op === 'setRange' || op.op === 'transformRange') return parseRange(op.range).cells;
  return 0;
}

/**
 * Apply one sheet op. Returns an optional structural note (insert/delete/style).
 * setStyle is currently a no-op placeholder that records a structural note — style
 * xf merging lands with preview cutover; value ops are the AI chart-safe path.
 */
export async function applySheetOp(workbook: XlsxWorkbook, op: XlsxSheetOp): Promise<string | null> {
  switch (op.op) {
    case 'setCell': {
      await workbook.setCell(op.sheet, op.ref, op.value ?? null, op.formula);
      return null;
    }
    case 'setRange': {
      const range = parseRange(op.range);
      for (let row = range.top; row <= range.bottom; row += 1) {
        for (let col = range.left; col <= range.right; col += 1) {
          const ref = cellRef(col, row);
          if (op.formula !== undefined) {
            await workbook.setCell(op.sheet, ref, null, fillFormula(op.formula, row, col));
          } else if (op.values !== undefined) {
            await workbook.setCell(op.sheet, ref, op.values[row - range.top][col - range.left]);
          } else {
            await workbook.setCell(op.sheet, ref, op.value ?? null);
          }
        }
      }
      return null;
    }
    case 'transformRange': {
      const range = parseRange(op.range);
      const maxRow = await workbook.maxRow(op.sheet);
      const bottom = Math.min(range.bottom, maxRow);
      for (let row = range.top; row <= bottom; row += 1) {
        for (let col = range.left; col <= range.right; col += 1) {
          const ref = cellRef(col, row);
          const current = await workbook.getCell(op.sheet, ref);
          await workbook.setCell(op.sheet, ref, transformValue(current, op));
        }
      }
      return null;
    }
    case 'replaceWhere': {
      const matchCol = columnNumber(op.matchColumn);
      const setCol = columnNumber(op.setColumn);
      const maxRow = await workbook.maxRow(op.sheet);
      const bottom = Math.min(op.toRow ?? maxRow, maxRow);
      for (let row = op.fromRow ?? 2; row <= bottom; row += 1) {
        const matched = await workbook.getCell(op.sheet, cellRef(matchCol, row));
        if (matched !== op.equals) continue;
        if (op.formula !== undefined) {
          await workbook.setCell(op.sheet, cellRef(setCol, row), null, fillFormula(op.formula, row, setCol));
        } else {
          await workbook.setCell(op.sheet, cellRef(setCol, row), op.value ?? null);
        }
      }
      return null;
    }
    case 'insertRows': {
      await workbook.spliceRows(op.sheet, op.at, 0, op.rows);
      return `${op.sheet}: +${op.rows.length} row(s) at ${op.at}`;
    }
    case 'deleteRows': {
      await workbook.spliceRows(op.sheet, op.at, op.count, []);
      return `${op.sheet}: -${op.count} row(s) from ${op.at}`;
    }
    case 'setStyle': {
      // Style xf merge is deferred to preview cutover; keep op accepted for tool schema compat.
      return `${op.sheet}!${op.ref}: style`;
    }
    case 'addSheet': {
      const name = await workbook.addSheet(op.name);
      return `+sheet ${name}`;
    }
    case 'deleteSheet': {
      await workbook.deleteSheet(op.sheet);
      return `-sheet ${op.sheet}`;
    }
    case 'renameSheet': {
      const name = workbook.renameSheet(op.sheet, op.newName);
      return `${op.sheet} → ${name}`;
    }
  }
}
