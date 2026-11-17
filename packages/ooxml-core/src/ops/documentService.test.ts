import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DocumentService, createGenericAdapter } from './documentService';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const sampleXlsx = path.join(repoRoot, 'samples/English/Sample Spreadsheet.xlsx');

describe('DocumentService', () => {
  it('opens, queries summary, and saves without changing part digests', async () => {
    const bytes = await readFile(sampleXlsx);
    const service = await DocumentService.open(bytes, { adapter: createGenericAdapter() });
    expect(service.rev).toBe(0);
    const summary = (await service.query.summary()) as { parts: string[] };
    expect(summary.parts.length).toBeGreaterThan(0);
    const before = await service.package.partDigests();
    const saved = await service.save();
    expect(saved.fingerprint).toHaveLength(16);
    const reopened = await DocumentService.open(saved.bytes, { adapter: createGenericAdapter() });
    const after = await reopened.package.partDigests();
    for (const [name, digest] of before) {
      expect(after.get(name), name).toBe(digest);
    }
  });

  it('apply bumps rev and emits change events', async () => {
    const bytes = await readFile(sampleXlsx);
    const service = await DocumentService.open(bytes, { adapter: createGenericAdapter() });
    const events: number[] = [];
    service.subscribe((event) => events.push(event.rev));
    const types = await service.package.readPartText('[Content_Types].xml');
    const result = await service.apply([
      {
        source: 'ai',
        target: { part: '[Content_Types].xml' },
        op: 'replacePartText',
        args: { text: `${types}\n` },
      },
    ]);
    expect(result.rev).toBe(1);
    expect(events).toEqual([1]);
  });

  it('refuses save when external fingerprint changes unless overwriteExternal', async () => {
    const bytes = await readFile(sampleXlsx);
    let external = 'aaaaaaaaaaaaaaaa';
    const service = await DocumentService.open(bytes, {
      adapter: createGenericAdapter(),
      readExternalFingerprint: async () => external,
    });
    // Align external to current fingerprint first.
    external = service.contentFingerprint;
    await service.save();
    external = 'bbbbbbbbbbbbbbbb';
    await expect(service.save()).rejects.toThrow(/EXTERNAL_MODIFIED/);
    await expect(service.save({ overwriteExternal: true })).resolves.toBeTruthy();
  });
});
