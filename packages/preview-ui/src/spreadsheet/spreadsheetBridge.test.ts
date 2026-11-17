import { describe, expect, it } from 'vitest';
import { isEditableSpreadsheetFile } from './editableFormats';
import {
  excelColumnWidthToPx,
  excelRowPointsToPx,
  workbookBytesToXsSheets,
  xsSheetsToWorkbookBytes,
} from './xSpreadsheetBridge';
import { worksheetToXsSheet } from './exceljsBridge';

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
  it('loads a brand-new empty worksheet whose ExcelJS columns is null', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1');
    const source = await workbook.xlsx.writeBuffer();
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const sheets = await workbookBytesToXsSheets(toArrayBuffer(bytes));
    expect(sheets[0]?.name).toBe('Sheet1');
    expect(sheets[0]?.cols?.len).toBeGreaterThan(0);
    expect(sheets[0]?.rows?.len).toBeGreaterThan(0);
  });

  it('rejects a tiny archive with an enormous merge before expanding the workbook', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml', '<worksheet><mergeCells><mergeCell ref="A1:XFD1048576"/></mergeCells></worksheet>');
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    await expect(workbookBytesToXsSheets(bytes)).rejects.toThrow(/容量|limit/);
  });
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
  it('keeps x-spreadsheet default font size for bold-only header cells (header row rendered empty)', async () => {
    const ExcelJS = (await import('exceljs')).default;
    // @ts-expect-error x-data-spreadsheet ships no types for its internal helper module.
    const helper = (await import('x-data-spreadsheet/src/core/helper.js')).default as { merge: (...sources: object[]) => any };
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('示例清单');
    sheet.addRow(['编号', '名称']);
    sheet.addRow(['A-001', '示例功能一']);
    for (const ref of ['A1', 'B1']) {
      sheet.getCell(ref).font = { bold: true };
      sheet.getCell(ref).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '00DDEBF7' } };
    }
    const source = await workbook.xlsx.writeBuffer();
    const [xs] = await workbookBytesToXsSheets(toArrayBuffer(source instanceof Uint8Array ? source : new Uint8Array(source)));
    const header = xs!.rows![0]!.cells![0]!;
    expect(header.text).toBe('编号');
    const style = xs!.styles![header.style as number]!;
    expect(style.font).toEqual({ bold: true, italic: false });
    expect(Object.values(style.font!).includes(undefined)).toBe(false);
    // Same merge x-spreadsheet applies before drawing a cell.
    const drawn = helper.merge({ font: { name: 'Arial', size: 10, bold: false, italic: false } }, style);
    expect(drawn.font).toEqual({ name: 'Arial', size: 10, bold: true, italic: false });
  });

  it('converts Excel column width, row height, zoom and accent fills into canvas units', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('入职');
    sheet.properties.defaultRowHeight = 17.5;
    sheet.properties.defaultColWidth = 9;
    sheet.getColumn(1).width = 32.783;
    sheet.getRow(1).height = 25.5;
    sheet.getCell('A1').value = '入职流程';
    sheet.getCell('A1').font = { name: '宋体', size: 20, bold: true };
    sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 4, tint: 0.8 } } as never;
    sheet.views = [{ state: 'normal', zoomScale: 85 }];

    const xs = worksheetToXsSheet(sheet, workbook);
    expect(xs.zoom).toBe(85);
    expect(xs.defaultRowPx).toBe(excelRowPointsToPx(17.5));
    expect(xs.defaultColPx).toBe(excelColumnWidthToPx(9));
    expect(xs.cols?.[0]?.width).toBe(excelColumnWidthToPx(32.783));
    expect(xs.rows?.[0]?.height).toBe(34);
    expect(xs.styles?.[0]?.font?.size).toBe(20);
    expect(xs.styles?.[0]?.bgcolor).toBe('#deebf7');

    const rewritten = await xsSheetsToWorkbookBytes([xs]);
    const [again] = await workbookBytesToXsSheets(toArrayBuffer(rewritten));
    expect(again?.cols?.[0]?.width).toBe(xs.cols?.[0]?.width);
    expect(again?.rows?.[0]?.height).toBe(34);
    expect(again?.styles?.[0]?.font?.size).toBe(20);
  });

  it('expands a header-only autoFilter so the filter menu can list column values', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('筛选');
    sheet.getCell('A1').value = '分工';
    sheet.getCell('B1').value = '备注';
    sheet.getCell('A2').value = '数据安全中台';
    sheet.getCell('A3').value = '数据安全运营';
    sheet.getCell('A4').value = '数据安全中台';
    sheet.getCell('B4').value = '说明';
    sheet.autoFilter = 'A1:B1';

    const xs = worksheetToXsSheet(sheet, workbook);
    expect(xs.autofilter?.ref).toBe('A1:B4');

    const source = await workbook.xlsx.writeBuffer();
    const [loaded] = await workbookBytesToXsSheets(toArrayBuffer(source instanceof Uint8Array ? source : new Uint8Array(source)));
    expect(loaded?.autofilter?.ref).toBe('A1:B4');
  });

  it('keeps borders on empty cells so blank grid cells still show their lines', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('表格');
    const box = {
      top: { style: 'thin' as const, color: { argb: 'FF000000' } },
      left: { style: 'thin' as const, color: { argb: 'FF000000' } },
      bottom: { style: 'thin' as const, color: { argb: 'FF000000' } },
      right: { style: 'thin' as const, color: { argb: 'FF000000' } },
    };
    sheet.getCell('A1').value = '标题';
    sheet.getCell('A1').border = box;
    // Empty string keeps the style through ExcelJS write/read; a null value would be dropped on write.
    sheet.getCell('B1').value = '';
    sheet.getCell('B1').border = box;
    sheet.getCell('A2').value = '';
    sheet.getCell('A2').border = box;
    sheet.getCell('B2').value = '';
    sheet.getCell('B2').border = box;

    const source = await workbook.xlsx.writeBuffer();
    const [xs] = await workbookBytesToXsSheets(toArrayBuffer(source instanceof Uint8Array ? source : new Uint8Array(source)));
    const empty = xs!.rows![0]!.cells![1]!;
    expect(empty.text).toBe('');
    expect(empty.style).toEqual(expect.any(Number));
    expect(xs!.styles![empty.style as number]!.border).toEqual({
      top: ['thin', '#000000'],
      right: ['thin', '#000000'],
      bottom: ['thin', '#000000'],
      left: ['thin', '#000000'],
    });
    expect(xs!.rows![1]!.cells![0]!.style).toEqual(expect.any(Number));
    expect(xs!.rows![1]!.cells![1]!.style).toEqual(expect.any(Number));
  });
});
