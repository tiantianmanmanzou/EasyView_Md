import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpcPackage } from '@easyview/ooxml-core/opc';
import { PptxPresentation } from '@easyview/ooxml-pptx';
import { OfficeBackupStore } from './office-backups';
import { createOfficeAgentTools, officeDocumentKind } from './office-tools';
import {
  commitPptxProposal,
  inspectPptxFile,
  planPptxEdit,
  undoPptxCommit,
} from './pptx-edit';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/preview/sample.pptx',
);

async function slideTexts(file: string): Promise<string[]> {
  const bytes = await readFile(file);
  const pkg = await OpcPackage.open(bytes);
  const deck = await PptxPresentation.open(pkg);
  const shapes = await deck.listShapes(0);
  return shapes.map((shape) => shape.text);
}

describe('pptx-edit', () => {
  let root = '';
  let file = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'easyview-pptx-edit-'));
    file = path.join(root, 'sample.pptx');
    await copyFile(FIXTURE, file);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('maps pptx paths via officeDocumentKind', () => {
    expect(officeDocumentKind('deck.pptx')).toBe('pptx');
    expect(officeDocumentKind('deck.potx')).toBe('pptx');
    expect(officeDocumentKind('deck.docx')).toBe('docx');
  });

  it('inspects fingerprint and numbered slide preview', async () => {
    const inspection = await inspectPptxFile(file, 5);
    expect(inspection.fileName).toBe('sample.pptx');
    expect(inspection.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(inspection.slideCount).toBe(1);
    expect(inspection.preview).toMatch(/^\[0\].*#\d+.*EasyView PowerPoint/);
  });

  it('plans replaceText, writes after commit, and undoes', async () => {
    const before = await readFile(file);
    const { fingerprint } = await inspectPptxFile(file);
    const proposal = await planPptxEdit(file, fingerprint, [
      { op: 'replaceText', slideIndex: 0, search: 'PPTX fixture', replaceWith: 'PPTX edited' },
    ]);
    expect(proposal.diff.changes).toHaveLength(1);
    expect(proposal.diff.changes[0]).toMatchObject({
      slideIndex: 0,
      before: expect.stringContaining('PPTX fixture'),
      after: expect.stringContaining('PPTX edited'),
    });
    expect(Buffer.compare(await readFile(file), before)).toBe(0);

    const backups = new OfficeBackupStore(path.join(root, 'backups'));
    const committed = await commitPptxProposal(proposal, backups);
    const texts = await slideTexts(file);
    expect(texts.join('\n')).toContain('PPTX edited');
    expect(texts.join('\n')).not.toContain('PPTX fixture');

    await undoPptxCommit(committed);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
  });

  it('setShapeText rewrites a whole shape by id', async () => {
    const { fingerprint } = await inspectPptxFile(file);
    const proposal = await planPptxEdit(file, fingerprint, [
      { op: 'setShapeText', slideIndex: 0, shapeId: 2, text: 'Title rewritten' },
    ]);
    await commitPptxProposal(proposal, new OfficeBackupStore(path.join(root, 'backups')));
    const texts = await slideTexts(file);
    expect(texts).toContain('Title rewritten');
  });
});

describe('pptx office agent tools', () => {
  let root = '';
  let file = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'easyview-pptx-tools-'));
    file = path.join(root, 'deck.pptx');
    await copyFile(FIXTURE, file);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = (tools: ReturnType<typeof createOfficeAgentTools>, name: string, input: unknown) =>
    (tools[name]!.execute as (value: unknown, options: unknown) => Promise<any>)(input, {
      toolCallId: 't',
      messages: [],
    });

  it('has no path parameter and writes only after acceptance', async () => {
    const original = await readFile(file);
    let decision = false;
    const shown: unknown[] = [];
    const tools = createOfficeAgentTools({
      kind: 'pptx',
      filePath: file,
      backups: new OfficeBackupStore(path.join(root, 'app-data')),
      confirmEdit: async (proposal) => {
        shown.push(proposal);
        return { accepted: decision };
      },
    });
    const inspected = await run(tools, 'inspect_presentation', { path: '/etc/passwd' });
    expect(inspected.fileName).toBe('deck.pptx');
    const ops = [{ op: 'replaceText', slideIndex: 0, search: 'Second line', replaceWith: 'Line two' }];
    expect(await run(tools, 'apply_slide_ops', { fingerprint: inspected.fingerprint, ops })).toMatchObject({
      status: 'rejected',
    });
    expect(Buffer.compare(await readFile(file), original)).toBe(0);
    decision = true;
    expect(await run(tools, 'apply_slide_ops', { fingerprint: inspected.fingerprint, ops })).toMatchObject({
      status: 'applied',
      changes: 1,
    });
    expect((await slideTexts(file)).join('\n')).toContain('Line two');
    expect(shown).toHaveLength(2);
    expect(await readdir(path.join(root, 'app-data'))).toHaveLength(1);
  });

  it('returns no-change without asking the user', async () => {
    let asked = false;
    const tools = createOfficeAgentTools({
      kind: 'pptx',
      filePath: file,
      backups: new OfficeBackupStore(path.join(root, 'app-data')),
      confirmEdit: async () => {
        asked = true;
        return { accepted: true };
      },
    });
    const { fingerprint } = await run(tools, 'inspect_presentation', {});
    expect(
      await run(tools, 'apply_slide_ops', {
        fingerprint,
        ops: [{ op: 'setShapeText', slideIndex: 0, shapeId: 2, text: 'EasyView PowerPoint' }],
      }),
    ).toEqual({ status: 'no-change' });
    expect(asked).toBe(false);
  });
});
