import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpcPackage } from '@easyview/ooxml-core';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { XlsxWorkbook } from './workbook';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sample = path.join(repoRoot, 'tests/fixtures/preview/sample.xlsx');

describe('xlsx write fidelity', () => {
  it('keeps a drawing part byte-identical after editing another sheet cell', async () => {
    const base = await readFile(sample);
    const zip = await JSZip.loadAsync(base);
    const drawing = new TextEncoder().encode(
      '<?xml version="1.0"?><wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><marker/></wsDr>',
    );
    zip.file('xl/drawings/drawing1.xml', drawing);
    // Point the worksheet at the drawing the way Excel would.
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    zip.file(
      'xl/worksheets/sheet1.xml',
      sheet.replace('</worksheet>', '<drawing r:id="rIdDraw"/></worksheet>'),
    );
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDraw" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`,
    );
    const seeded = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });

    const pkg = await OpcPackage.open(seeded);
    const beforeDrawing = await pkg.readPart('xl/drawings/drawing1.xml');
    const beforeRels = await pkg.readPart('xl/worksheets/_rels/sheet1.xml.rels');
    const workbook = await XlsxWorkbook.open(pkg);
    await workbook.setCell('Preview', 'B3', 42);
    await workbook.flush();
    const saved = await pkg.save();

    const out = await OpcPackage.open(saved);
    expect(Buffer.from(await out.readPart('xl/drawings/drawing1.xml')).equals(Buffer.from(beforeDrawing))).toBe(true);
    expect(Buffer.from(await out.readPart('xl/worksheets/_rels/sheet1.xml.rels')).equals(Buffer.from(beforeRels))).toBe(true);
    const again = await XlsxWorkbook.open(out);
    expect(await again.getCell('Preview', 'B3')).toBe(42);
    expect(await again.getCell('Preview', 'A1')).toBe('Name');
  });
});
