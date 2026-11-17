import { describe, expect, it } from 'vitest';
import { formatExcelDate } from './excelDateFormat';
import { workbookBytesToXsSheets } from './xSpreadsheetBridge';

const day = new Date(Date.UTC(2026, 7, 26));
const moment = new Date(Date.UTC(2027, 11, 31, 13, 5, 9));

describe('formatExcelDate', () => {
  it('shows the built-in short date like Excel/WPS in a Chinese locale', () => {
    expect(formatExcelDate(day, 'mm-dd-yy')).toBe('2026/8/26');
    expect(formatExcelDate(moment, 'm/d/yy "h":mm')).toBe('2027/12/31 13:05');
  });

  it('follows custom date and time codes', () => {
    expect(formatExcelDate(day, 'yyyy-mm-dd')).toBe('2026-08-26');
    expect(formatExcelDate(day, 'yyyy"年"m"月"d"日"')).toBe('2026年8月26日');
    expect(formatExcelDate(day, '[$-804]yyyy/m/d;@')).toBe('2026/8/26');
    expect(formatExcelDate(moment, 'yyyy/m/d hh:mm:ss')).toBe('2027/12/31 13:05:09');
    expect(formatExcelDate(moment, 'h:mm AM/PM')).toBe('1:05 PM');
    expect(formatExcelDate(moment, '上午/下午h"时"mm"分"')).toBe('下午1时05分');
    expect(formatExcelDate(day, 'd-mmm-yy')).toBe('26-Aug-26');
    expect(formatExcelDate(day, 'yyyy/m/d aaaa')).toBe('2026/8/26 星期三');
  });

  it('falls back to a readable date when the cell has no date format', () => {
    expect(formatExcelDate(day, undefined)).toBe('2026/8/26');
    expect(formatExcelDate(moment, 'General')).toBe('2027/12/31 13:05:09');
  });
});

describe('spreadsheet date cells', () => {
  it('renders date values and date formula results with their number format', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sheet1');
    sheet.getCell('B4').value = day;
    sheet.getCell('B4').numFmt = 'mm-dd-yy';
    sheet.getCell('B5').value = day;
    sheet.getCell('B5').numFmt = 'yyyy"年"m"月"d"日"';
    sheet.getCell('B6').value = { formula: 'B4', result: day };
    sheet.getCell('B6').numFmt = 'yyyy-mm-dd';
    const buffer = await workbook.xlsx.writeBuffer();
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const [loaded] = await workbookBytesToXsSheets(bytes.slice().buffer);
    const text = (row: number) => (loaded.rows?.[row] as { cells?: Record<number, { text?: string }> } | undefined)?.cells?.[1]?.text;
    expect([text(3), text(4), text(5)]).toEqual(['2026/8/26', '2026年8月26日', '2026-08-26']);
  });
});
