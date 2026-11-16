/**
 * Cross-format fidelity harness against sample/{xlsx,docx,pptx} fixtures.
 * DocumentService apply + save must keep untouched OPC parts byte-identical.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DocumentService, OpcPackage } from '@easyview/ooxml-core';
import { createDocxAdapter } from '@easyview/ooxml-docx';
import { createPptxAdapter } from '@easyview/ooxml-pptx';
import { createXlsxAdapter } from '@easyview/ooxml-xlsx';
import type { DocumentOp } from '@easyview/ooxml-core/ops';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function partMap(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const pkg = await OpcPackage.open(bytes);
  const out = new Map<string, Uint8Array>();
  for (const name of pkg.listParts()) {
    out.set(name, await pkg.readPart(name));
  }
  return out;
}

function assertUntouched(
  before: Map<string, Uint8Array>,
  after: Map<string, Uint8Array>,
  names: string[],
): void {
  for (const name of names) {
    const a = before.get(name);
    const b = after.get(name);
    expect(a, `missing before ${name}`).toBeTruthy();
    expect(b, `missing after ${name}`).toBeTruthy();
    expect(Buffer.compare(Buffer.from(a!), Buffer.from(b!))).toBe(0);
  }
}

describe('sample fidelity harness', () => {
  it('xlsx setCell keeps styles and content types intact', async () => {
    const bytes = new Uint8Array(await readFile(path.join(repoRoot, 'sample/xlsx/sample.xlsx')));
    const before = await partMap(bytes);
    const service = await DocumentService.open(bytes, { adapter: createXlsxAdapter() });
    const summary = (await service.query.summary()) as { sheets?: Array<{ name: string }> };
    const sheet = summary.sheets?.[0]?.name ?? 'Sheet1';
    const ops: DocumentOp[] = [
      {
        source: 'ai',
        target: { key: sheet },
        op: 'setCell',
        args: { sheet, ref: 'A1', value: 'harness' },
      },
    ];
    await service.apply(ops);
    const saved = await service.save();
    const after = await partMap(saved.bytes);
    assertUntouched(before, after, ['xl/styles.xml', '[Content_Types].xml']);
    const check = await DocumentService.open(saved.bytes, { adapter: createXlsxAdapter() });
    const cell = (await check.query.read({ key: `${sheet}!A1` })) as { value?: unknown };
    expect(cell.value).toBe('harness');
  });

  it('docx replace_text keeps styles intact', async () => {
    const bytes = new Uint8Array(await readFile(path.join(repoRoot, 'sample/docx/sample.docx')));
    const before = await partMap(bytes);
    const service = await DocumentService.open(bytes, { adapter: createDocxAdapter() });
    const preview = (await service.query.read({ key: 'preview' })) as { preview?: string };
    const line = (preview.preview ?? '').split('\n')[0] ?? '';
    const phrase = line.replace(/^\[\d+\]\s*/, '').slice(0, 6);
    expect(phrase.length).toBeGreaterThan(0);
    await service.apply([
      {
        source: 'ai',
        target: { part: 'word/document.xml' },
        op: 'replace_text',
        args: { op: 'replace_text', paragraphIndex: 0, search: phrase, replaceWith: `${phrase}!!` },
      },
    ]);
    const saved = await service.save();
    const after = await partMap(saved.bytes);
    assertUntouched(before, after, ['word/styles.xml', '[Content_Types].xml']);
    const again = await DocumentService.open(saved.bytes, { adapter: createDocxAdapter() });
    const next = (await again.query.read({ key: 'preview' })) as { preview?: string };
    expect(next.preview).toContain(`${phrase}!!`);
  });

  it('pptx replaceText keeps presentation.xml intact', async () => {
    const bytes = new Uint8Array(await readFile(path.join(repoRoot, 'sample/pptx/sample.pptx')));
    const before = await partMap(bytes);
    const service = await DocumentService.open(bytes, { adapter: createPptxAdapter() });
    await service.apply([
      {
        source: 'ai',
        target: { key: 'slide:0' },
        op: 'slideOp',
        args: { op: 'replaceText', slideIndex: 0, search: 'PPTX fixture', replaceWith: 'PPTX harness' },
      },
    ]);
    const saved = await service.save();
    const after = await partMap(saved.bytes);
    assertUntouched(before, after, ['ppt/presentation.xml', '[Content_Types].xml']);
    const again = await DocumentService.open(saved.bytes, { adapter: createPptxAdapter() });
    const slide = (await again.query.read({ key: 'slide:0' })) as {
      shapes?: Array<{ text: string }>;
    };
    expect(slide.shapes?.some((shape) => shape.text.includes('PPTX harness'))).toBe(true);
  });
});
