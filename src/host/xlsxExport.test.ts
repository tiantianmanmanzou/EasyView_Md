/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildXlsxBuffer } from './xlsxExport';
import type { XlsxTablePayload } from '../shared/xlsxExport';

describe('buildXlsxBuffer', () => {
  it('produces a workbook with merges, thin borders and header bold', async () => {
    const payload: XlsxTablePayload = {
      totalRows: 2,
      totalCols: 3,
      cells: [
        { row: 0, col: 0, text: '一级', rowspan: 2, colspan: 1, isHeader: true, alignment: 'left', verticalAlignment: 'top' },
        { row: 0, col: 1, text: '一级描述', rowspan: 2, colspan: 1, isHeader: true, alignment: 'left', verticalAlignment: 'top' },
        { row: 0, col: 2, text: '三级A', rowspan: 1, colspan: 1, isHeader: false, alignment: null, verticalAlignment: null },
        { row: 1, col: 2, text: '三级B', rowspan: 1, colspan: 1, isHeader: false, alignment: null, verticalAlignment: null },
      ],
      merges: [
        { top: 0, left: 0, bottom: 1, right: 0 },
        { top: 0, left: 1, bottom: 1, right: 1 },
      ],
      columnWidths: [100, 120, 80],
      rowHeights: [40, 40],
    };

    const buffer = await buildXlsxBuffer(payload);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Sheet1')!;

    expect(ws).toBeDefined();
    expect(ws.getCell('A1').value).toBe('一级');
    expect(ws.getCell('C1').value).toBe('三级A');
    expect(ws.getCell('C2').value).toBe('三级B');
    expect(ws.model.merges).toEqual(['A1:A2', 'B1:B2']);
    expect(ws.getCell('A1').border?.top?.style).toBe('thin');
    expect(ws.getCell('A1').font?.bold).toBe(true);
    expect(ws.getCell('C2').font?.bold).toBeFalsy();
  });
});
