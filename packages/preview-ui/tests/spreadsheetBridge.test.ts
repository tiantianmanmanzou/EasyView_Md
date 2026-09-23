import { describe, expect, it } from 'vitest';
import { isEditableSpreadsheetFile } from '../src/spreadsheet/editableFormats';
import {
  workbookBytesToXsSheets,
  xsSheetsToWorkbookBytes,
} from '../src/spreadsheet/xSpreadsheetBridge';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

describe('editable spreadsheet formats', () => {
  it('enables edit for xlsx/xlsm only', () => {
    expect(isEditableSpreadsheetFile('a.xlsx')).toBe(true);
    expect(isEditableSpreadsheetFile('a.XLSM')).toBe(true);
    expect(isEditableSpreadsheetFile('a.xls')).toBe(false);
    expect(isEditableSpreadsheetFile('a.ods')).toBe(false);
  });
});

describe('xSpreadsheetBridge', () => {
  it('round-trips a simple workbook and drops merge-slave cells', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('功能清单');
    sheet.getCell('A1').value = '序号';
    sheet.getCell('A1').font = { bold: true };
    sheet.getCell('B1').value = '一级功能';
    sheet.getCell('A2').value = 1;
    sheet.getCell('B2').value = '数据资产运营';
    sheet.mergeCells('B2:C3');
    const source = await workbook.xlsx.writeBuffer();
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const ab = toArrayBuffer(bytes);

    const sheets = await workbookBytesToXsSheets(ab);
    expect(sheets[0]?.name).toBe('功能清单');
    expect(sheets[0]?.rows?.[0]?.cells?.[0]?.text).toBe('序号');
    expect(sheets[0]?.rows?.[1]?.cells?.[1]?.text).toBe('数据资产运营');
    expect(sheets[0]?.rows?.[2]?.cells?.[1]).toBeUndefined();
    expect(sheets[0]?.rows?.[2]?.cells?.[2]).toBeUndefined();
    expect(sheets[0]?.rows?.[1]?.cells?.[1]?.merge).toEqual([1, 1]);

    const rewritten = await xsSheetsToWorkbookBytes(sheets);
    const again = await workbookBytesToXsSheets(
      toArrayBuffer(rewritten),
    );
    expect(again[0]?.rows?.[0]?.cells?.[0]?.text).toBe('序号');
    expect(again[0]?.rows?.[1]?.cells?.[1]?.text).toBe('数据资产运营');
  });

  it('still loads heavily-merged workbooks into the editable engine', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('复杂');
    for (let i = 0; i < 50; i += 1) {
      const row = i + 1;
      sheet.getCell(`A${row}`).value = `v${i}`;
      sheet.mergeCells(`A${row}:B${row}`);
    }
    const source = await workbook.xlsx.writeBuffer();
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const ab = toArrayBuffer(bytes);
    const sheets = await workbookBytesToXsSheets(ab);
    expect(sheets[0]?.name).toBe('复杂');
    expect(sheets[0]?.rows?.[0]?.cells?.[0]?.text).toBe('v0');
    expect(sheets[0]?.rows?.[0]?.cells?.[0]?.merge).toEqual([0, 1]);
  });
});
