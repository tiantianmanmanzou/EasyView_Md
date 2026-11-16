import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentService, OpcPackage } from '@easyview/ooxml-core';
import { describe, expect, it } from 'vitest';
import { createXlsxAdapter } from './adapter';
import { XlsxWorkbook } from './workbook';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sample = path.join(repoRoot, 'tests/fixtures/preview/sample.xlsx');

describe('XlsxWorkbook', () => {
  it('reads cells and preserves untouched parts after a cell edit', async () => {
    const bytes = await readFile(sample);
    const pkg = await OpcPackage.open(bytes);
    const before = await pkg.partDigests();
    const workbook = await XlsxWorkbook.open(pkg);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Preview']);
    expect(await workbook.getCell('Preview', 'A1')).toBe('Name');
    expect(await workbook.getCell('Preview', 'B2')).toBe(1);

    await workbook.setCell('Preview', 'B2', 99);
    const dirty = await workbook.flush();
    expect(dirty).toContain('xl/worksheets/sheet1.xml');

    const saved = await pkg.save();
    const reopened = await OpcPackage.open(saved);
    const after = await reopened.partDigests();
    for (const [name, digest] of before) {
      if (name === 'xl/worksheets/sheet1.xml' || name === 'xl/workbook.xml') continue;
      expect(after.get(name), name).toBe(digest);
    }
    const again = await XlsxWorkbook.open(reopened);
    expect(await again.getCell('Preview', 'B2')).toBe(99);
    expect(await again.getCell('Preview', 'A1')).toBe('Name');
  });

  it('DocumentService apply + save round-trips through the adapter', async () => {
    const bytes = await readFile(sample);
    const service = await DocumentService.open(bytes, { adapter: createXlsxAdapter() });
    const summary = (await service.query.summary()) as { sheets: Array<{ name: string }> };
    expect(summary.sheets[0].name).toBe('Preview');
    await service.apply([
      {
        source: 'ai',
        target: { key: 'Preview' },
        op: 'sheetOp',
        args: { op: 'setCell', sheet: 'Preview', ref: 'A2', value: 'Gamma' },
      },
    ]);
    const saved = await service.save();
    const check = await DocumentService.open(saved.bytes, { adapter: createXlsxAdapter() });
    const cell = (await check.query.read({ key: 'Preview!A2' })) as { value: string };
    expect(cell.value).toBe('Gamma');
  });
});
