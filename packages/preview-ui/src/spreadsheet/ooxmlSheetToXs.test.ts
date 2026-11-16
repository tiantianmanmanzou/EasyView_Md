import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { LazyWorkbook } from './lazyWorkbook';
import { worksheetToXsSheet } from './xSpreadsheetBridge';

describe('ooxmlSheetToXs parity', () => {
  it('matches ExcelJS defaultRowPx and cell text for the e2e fixture grid', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Data');
    for (let r = 1; r <= 6; r += 1) for (let c = 1; c <= 4; c += 1) sheet.getCell(r, c).value = r * 10 + c;
    const buf = await book.xlsx.writeBuffer();
    const bytes = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer;

    const excelWb = new ExcelJS.Workbook();
    await excelWb.xlsx.load(bytes);
    const viaExcel = worksheetToXsSheet(excelWb.worksheets[0], excelWb);
    const viaOoxml = await (await LazyWorkbook.open(bytes)).load(0);

    expect(viaOoxml.defaultRowPx).toBe(viaExcel.defaultRowPx);
    expect(viaOoxml.defaultRowPx).toBe(20);
    expect(viaOoxml.rows?.[3]?.cells?.[1]?.text).toBe('42'); // B4
    expect(viaOoxml.rows?.[2]?.cells?.[2]?.text).toBe('33'); // C3
  });

  it('round-trips pasted cell text like the clipboard e2e', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Data');
    for (let r = 1; r <= 6; r += 1) for (let c = 1; c <= 4; c += 1) sheet.getCell(r, c).value = r * 10 + c;
    const buf = await book.xlsx.writeBuffer();
    const bytes = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer;
    const lazy = await LazyWorkbook.open(bytes);
    const data = await lazy.load(0);
    data.rows![1].cells![1] = { text: 'hello' };
    data.rows![2].cells![2] = { text: 'a' };
    data.rows![2].cells![3] = { text: 'he said "hi"' };
    data.rows![3].cells![2] = { text: 'c' };
    data.rows![3].cells![3] = { text: 'd' };
    data.rows![6] = { cells: { 0: { text: 'fresh' } } };
    data.rows![0].cells![3] = { text: '14+x' };

    const saved = await lazy.save([{ index: 0, data }]);
    const read = new ExcelJS.Workbook();
    await read.xlsx.load(saved.buffer as ArrayBuffer);
    const ws = read.worksheets[0];
    expect(['B2', 'C3', 'D3', 'C4', 'D4', 'A7', 'D1'].map((ref) => String(ws.getCell(ref).value))).toEqual([
      'hello',
      'a',
      'he said "hi"',
      'c',
      'd',
      'fresh',
      '14+x',
    ]);
  });

  it('round-trips merge B4:C4 and freeze C3 like the toolbar e2e', async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Data');
    for (let r = 1; r <= 6; r += 1) for (let c = 1; c <= 4; c += 1) sheet.getCell(r, c).value = r * 10 + c;
    const buf = await book.xlsx.writeBuffer();
    const bytes = buf instanceof ArrayBuffer ? buf : new Uint8Array(buf).buffer;
    const lazy = await LazyWorkbook.open(bytes);
    const data = await lazy.load(0);
    data.merges = ['B4:C4'];
    data.freeze = 'C3';
    data.autofilter = { ref: 'A1:D6', filters: [] };
    data.styles = [...(data.styles ?? []), { font: { bold: true }, bgcolor: '#ffff00' }];
    data.rows![1].cells![1] = { ...(data.rows![1].cells![1] ?? { text: '22' }), style: data.styles.length - 1 };

    const saved = await lazy.save([{ index: 0, data }]);
    const back = await (await LazyWorkbook.open(saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength) as ArrayBuffer)).load(0);
    expect(back.merges).toEqual(['B4:C4']);
    expect(back.freeze).toBe('C3');
    expect(back.autofilter?.ref).toBe('A1:D6');
    expect(back.defaultRowPx).toBe(20);

    const read = new ExcelJS.Workbook();
    await read.xlsx.load(saved.buffer as ArrayBuffer);
    expect((read.worksheets[0].model as { merges?: string[] }).merges).toContain('B4:C4');
    expect(read.worksheets[0].views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 2 });
  });
});
