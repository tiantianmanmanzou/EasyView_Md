import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpcPackage } from './package';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sampleXlsx = path.join(repoRoot, 'samples/English/Sample Spreadsheet.xlsx');

describe('OpcPackage', () => {
  it('lists parts from a real xlsx sample', async () => {
    const bytes = await readFile(sampleXlsx);
    const pkg = await OpcPackage.open(bytes);
    const parts = pkg.listParts();
    expect(parts).toContain('[Content_Types].xml');
    expect(parts.some((name) => name.startsWith('xl/'))).toBe(true);
  });

  it('keeps uncompressed part digests identical after open → save with no edits', async () => {
    const bytes = await readFile(sampleXlsx);
    const pkg = await OpcPackage.open(bytes);
    const before = await pkg.partDigests();
    await pkg.save();
    const after = await pkg.partDigests();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [name, digest] of before) {
      expect(after.get(name), name).toBe(digest);
    }
  });

  it('only dirties the rewritten part digest', async () => {
    const bytes = await readFile(sampleXlsx);
    const pkg = await OpcPackage.open(bytes);
    const before = await pkg.partDigests();
    const sheet = pkg.listParts().find((name) => /xl\/worksheets\/.+\.xml$/i.test(name));
    expect(sheet).toBeTruthy();
    const text = await pkg.readPartText(sheet!);
    pkg.writePartText(sheet!, `${text}\n`);
    expect(pkg.isDirty(sheet!)).toBe(true);
    await pkg.save();
    const after = await pkg.partDigests();
    for (const [name, digest] of before) {
      if (name === sheet) {
        expect(after.get(name)).not.toBe(digest);
      } else {
        expect(after.get(name), name).toBe(digest);
      }
    }
  });
});
