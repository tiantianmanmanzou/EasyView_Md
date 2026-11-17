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

  it('cascades formula row references when inserting rows', async () => {
    const bytes = await readFile(sample);
    const pkg = await OpcPackage.open(bytes);
    const workbook = await XlsxWorkbook.open(pkg);
    await workbook.setCell('Preview', 'C2', null, 'B2*2');
    await workbook.spliceRows('Preview', 2, 0, [['x']]);
    expect(await workbook.getCell('Preview', 'A2')).toBe('x');
    expect(await workbook.getCell('Preview', 'C3')).toBe('=B3*2');
  });

  it('cascades defined names and drawing anchors on row insert', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await readFile(sample));
    zip.file(
      'xl/drawings/drawing1.xml',
      `<?xml version="1.0"?><wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing">
  <xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>1</xdr:row></xdr:from>
  <xdr:to><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:to></xdr:twoCellAnchor></wsDr>`,
    );
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`,
    );
    let workbookXml = await zip.file('xl/workbook.xml')!.async('string');
    workbookXml = workbookXml.replace(
      /<definedNames\/>/,
      '<definedNames><definedName name="Range">Preview!$A$2:$A$5</definedName></definedNames>',
    );
    zip.file('xl/workbook.xml', workbookXml);
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const pkg = await OpcPackage.open(bytes);
    const workbook = await XlsxWorkbook.open(pkg);
    await workbook.spliceRows('Preview', 2, 0, [['inserted']]);
    const dirty = await workbook.flush();
    expect(dirty).toEqual(expect.arrayContaining(['xl/drawings/drawing1.xml', 'xl/workbook.xml']));
    const drawing = await pkg.readPartText('xl/drawings/drawing1.xml');
    expect(drawing).toContain('<xdr:row>2</xdr:row>');
    expect(drawing).toContain('<xdr:row>3</xdr:row>');
    expect(await pkg.readPartText('xl/workbook.xml')).toContain('Preview!$A$3:$A$6');
  });

  it('adds, renames, and deletes worksheets while keeping styles intact', async () => {
    const bytes = await readFile(sample);
    const pkg = await OpcPackage.open(bytes);
    const stylesBefore = await pkg.readPart('xl/styles.xml');
    const workbook = await XlsxWorkbook.open(pkg);

    const added = await workbook.addSheet('Extra');
    expect(added).toBe('Extra');
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Preview', 'Extra']);
    await workbook.setCell('Extra', 'A1', 'hello');
    const renamed = workbook.renameSheet('Extra', 'More');
    expect(renamed).toBe('More');
    expect(await workbook.getCell('More', 'A1')).toBe('hello');

    const dirty = await workbook.flush();
    expect(dirty).toEqual(expect.arrayContaining(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels']));

    const mid = await pkg.save();
    const midPkg = await OpcPackage.open(mid);
    expect(Buffer.compare(Buffer.from(stylesBefore), Buffer.from(await midPkg.readPart('xl/styles.xml')))).toBe(0);
    const midBook = await XlsxWorkbook.open(midPkg);
    expect(midBook.sheets.map((sheet) => sheet.name)).toEqual(['Preview', 'More']);
    expect(await midBook.getCell('More', 'A1')).toBe('hello');

    await midBook.deleteSheet('More');
    await midBook.flush();
    const end = await XlsxWorkbook.open(await OpcPackage.open(await midPkg.save()));
    expect(end.sheets.map((sheet) => sheet.name)).toEqual(['Preview']);
    await expect(end.deleteSheet('Preview')).rejects.toThrow(/last worksheet/i);
  });
});
