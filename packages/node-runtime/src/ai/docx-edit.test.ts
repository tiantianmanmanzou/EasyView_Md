import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocxReviewer } from '@easyview/docx-agents';
import { OfficeBackupStore } from './office-backups';
import { createOfficeAgentTools } from './office-tools';
import {
  commitDocxProposal,
  inspectDocxFile,
  planDocxEdit,
  undoDocxCommit,
} from './docx-edit';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docx-core/test-fixtures/styled-content.docx',
);

async function loadReviewer(file: string): Promise<DocxReviewer> {
  const bytes = await readFile(file);
  return DocxReviewer.fromBuffer(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    'Test',
  );
}

describe('docx-edit', () => {
  let root = '';
  let file = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'easyview-docx-edit-'));
    file = path.join(root, 'sample.docx');
    await copyFile(FIXTURE, file);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('inspects fingerprint and numbered preview', async () => {
    const inspection = await inspectDocxFile(file, 5);
    expect(inspection.fileName).toBe('sample.docx');
    expect(inspection.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(inspection.paragraphCount).toBeGreaterThan(0);
    expect(inspection.preview).toMatch(/^\[\d+]/);
  });

  it('plans replace_text + comment, writes body only after commit, and undoes', async () => {
    const before = await readFile(file);
    const { fingerprint } = await inspectDocxFile(file);
    const reviewer = await loadReviewer(file);
    const first = reviewer.getContentAsText({ toIndex: 0, includeTrackedChanges: false, includeCommentAnchors: false });
    const phrase = first.replace(/^\[\d+\]\s*/, '').slice(0, 8);
    expect(phrase.length).toBeGreaterThan(0);

    const proposal = await planDocxEdit(file, fingerprint, [
      { op: 'replace_text', paragraphIndex: 0, search: phrase, replaceWith: `${phrase}【正文】` },
      { op: 'add_comment', paragraphIndex: 0, text: '请核对措辞' },
    ]);
    expect(proposal.diff.changes).toHaveLength(1);
    expect(proposal.diff.comments).toHaveLength(1);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);

    const backups = new OfficeBackupStore(path.join(root, 'backups'));
    const committed = await commitDocxProposal(proposal, backups, {});
    const after = await loadReviewer(file);
    expect(after.getChanges()).toHaveLength(0);
    expect(after.getContentAsText({ toIndex: 0 })).toContain(`${phrase}【正文】`);
    expect(after.getComments()).toHaveLength(1);

    await undoDocxCommit(committed);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
  });

  it('legacy suggest_change alias also writes body text', async () => {
    const { fingerprint } = await inspectDocxFile(file);
    const reviewer = await loadReviewer(file);
    const first = reviewer.getContentAsText({ toIndex: 0, includeTrackedChanges: false, includeCommentAnchors: false });
    const phrase = first.replace(/^\[\d+\]\s*/, '').slice(0, 6);
    const proposal = await planDocxEdit(file, fingerprint, [
      { op: 'suggest_change', paragraphIndex: 0, search: phrase, replaceWith: `${phrase}OK` },
    ]);
    await commitDocxProposal(proposal, new OfficeBackupStore(path.join(root, 'backups')), {});
    const after = await loadReviewer(file);
    expect(after.getChanges()).toHaveLength(0);
    expect(after.getContentAsText({ toIndex: 0 })).toContain(`${phrase}OK`);
  });

  it('itemDecisions can drop individual body edits before write', async () => {
    const { fingerprint } = await inspectDocxFile(file);
    const text = (await loadReviewer(file)).getContentAsText({
      toIndex: 1,
      includeTrackedChanges: false,
      includeCommentAnchors: false,
    });
    const lines = text.split('\n').filter(Boolean);
    const p0 = lines[0]?.replace(/^\[\d+\]\s*/, '').slice(0, 5) ?? '';
    const p1 = lines[1]?.replace(/^\[\d+\]\s*/, '').slice(0, 5) ?? '';
    expect(p0 && p1).toBeTruthy();
    const proposal = await planDocxEdit(file, fingerprint, [
      { op: 'replace_text', paragraphIndex: 0, search: p0, replaceWith: `${p0}A` },
      { op: 'replace_text', paragraphIndex: 1, search: p1, replaceWith: `${p1}B` },
    ]);
    expect(proposal.diff.changes).toHaveLength(2);
    await commitDocxProposal(proposal, new OfficeBackupStore(path.join(root, 'backups')), {
      itemDecisions: [
        { index: 0, accept: true },
        { index: 1, accept: false },
      ],
    });
    const after = await loadReviewer(file);
    expect(after.getChanges()).toHaveLength(0);
    const body = after.getContentAsText({ toIndex: 1, includeTrackedChanges: false, includeCommentAnchors: false });
    expect(body).toContain(`${p0}A`);
    expect(body).not.toContain(`${p1}B`);
  });

  it('refuses a stale fingerprint', async () => {
    await expect(
      planDocxEdit(file, 'deadbeefdeadbeef', [
        { op: 'add_comment', paragraphIndex: 0, text: 'x' },
      ]),
    ).rejects.toThrow(/inspect_document|fingerprint|修改/i);
  });
});

describe('office agent tools (docx)', () => {
  let root = '';
  let file = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'easyview-docx-tools-'));
    file = path.join(root, 'doc.docx');
    await copyFile(FIXTURE, file);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = (tools: ReturnType<typeof createOfficeAgentTools>, name: string, input: unknown) =>
    (tools[name]!.execute as (value: unknown, options: unknown) => Promise<unknown>)(input, {
      toolCallId: 't',
      messages: [],
    });

  it('exposes inspect_document / apply_docx_ops and writes body only after acceptance', async () => {
    const original = await readFile(file);
    let decisionAccepted = false;
    const tools = createOfficeAgentTools({
      kind: 'docx',
      filePath: file,
      backups: new OfficeBackupStore(path.join(root, 'app-data')),
      confirmEdit: async () => ({ accepted: decisionAccepted }),
    });
    const inspected = (await run(tools, 'inspect_document', {})) as {
      fingerprint: string;
      preview: string;
    };
    const phrase = inspected.preview.split('\n')[0]?.replace(/^\[\d+\]\s*/, '').slice(0, 6) ?? '';
    const ops = [
      { op: 'replace_text' as const, paragraphIndex: 0, search: phrase, replaceWith: `${phrase}X` },
      { op: 'add_comment' as const, paragraphIndex: 0, text: 'note' },
    ];
    expect(await run(tools, 'apply_docx_ops', { fingerprint: inspected.fingerprint, ops })).toMatchObject({
      status: 'rejected',
    });
    expect(Buffer.compare(await readFile(file), original)).toBe(0);

    decisionAccepted = true;
    expect(await run(tools, 'apply_docx_ops', { fingerprint: inspected.fingerprint, ops })).toMatchObject({
      status: 'applied',
      resolution: 'accept-all',
    });
    expect((await loadReviewer(file)).getComments()).toHaveLength(1);
    expect((await loadReviewer(file)).getChanges()).toHaveLength(0);
    expect((await loadReviewer(file)).getContentAsText({ toIndex: 0 })).toContain(`${phrase}X`);
  });
});
