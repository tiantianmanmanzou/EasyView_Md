import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildXlsxFromTable } from './tableExport';
import { XlsxWorkbook } from './workbook';
import { OpcPackage } from '@easyview/ooxml-core/opc';

describe('buildXlsxFromTable', () => {
  it('emits readable cells, header bold style, merges and column widths', async () => {
    const bytes = await buildXlsxFromTable({
      cells: [
        { row: 0, col: 0, text: 'Name', isHeader: true },
        { row: 0, col: 1, text: 'Qty', isHeader: true },
        { row: 1, col: 0, text: 'Apple' },
        { row: 1, col: 1, text: '3' },
      ],
      merges: [{ top: 0, left: 0, bottom: 0, right: 1 }],
      columnWidths: [100, 80],
      totalRows: 2,
      totalCols: 2,
    });

    const zip = await JSZip.loadAsync(bytes);
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toContain('Apple');
    expect(sheet).toContain('<mergeCell ref="A1:B1"/>');
    expect(sheet).toContain('customWidth="1"');

    const pkg = await OpcPackage.open(bytes);
    const book = await XlsxWorkbook.open(pkg);
    expect(await book.getCell('Sheet1', 'A2')).toBe('Apple');
    expect(await book.getCell('Sheet1', 'B2')).toBe('3');

    const styles = await zip.file('xl/styles.xml')!.async('string');
    expect(styles).toContain('<b/>');
  });
});
