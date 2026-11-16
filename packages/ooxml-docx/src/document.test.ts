import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import { DocxDocument } from './document';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../docx-core/test-fixtures/styled-content.docx',
);

describe('DocxDocument body apply', () => {
  let root = '';
  let file = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'easyview-ooxml-docx-'));
    file = path.join(root, 'sample.docx');
    await copyFile(FIXTURE, file);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('replaces paragraph text into the body without tracked changes', async () => {
    const bytes = await readFile(file);
    const pkg = await OpcPackage.open(bytes);
    const stylesBefore = await pkg.readPart('word/styles.xml');
    const document = await DocxDocument.open(pkg, 'Test');
    const preview = await document.previewText(1);
    const phrase = preview.preview.replace(/^\[\d+\]\s*/, '').slice(0, 6);
    expect(phrase.length).toBeGreaterThan(0);

    const result = await document.applyBodyOps([
      { op: 'replace_text', paragraphIndex: 0, search: phrase, replaceWith: `${phrase}!!` },
    ]);
    expect(result.changes).toBe(1);
    const dirty = await document.flush();
    expect(dirty).toEqual(['word/document.xml']);
    const saved = await pkg.save();

    const againPkg = await OpcPackage.open(saved);
    const stylesAfter = await againPkg.readPart('word/styles.xml');
    expect(Buffer.compare(Buffer.from(stylesBefore), Buffer.from(stylesAfter))).toBe(0);
    const again = await DocxDocument.open(againPkg, 'Test');
    const after = await again.previewText(1);
    expect(after.preview).toContain(`${phrase}!!`);
  });
});
