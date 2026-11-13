import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostToEditorMessage } from '@easyview/contracts';
import { AiChatHost } from './ai-chat-host';
import { inspectXlsxFile } from './xlsx-edit';

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });

describe('AiChatHost office (xlsx) agent', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  async function setup(accept: boolean) {
    dir = await mkdtemp(path.join(os.tmpdir(), 'easyview-host-xlsx-'));
    const file = path.join(dir, 'book.xlsx');
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sales').addRows([['Name', 'Qty'], ['Apple', 3]]);
    await workbook.xlsx.writeFile(file);
    const { fingerprint } = await inspectXlsxFile(file);
    const bodies: any[] = [];
    let call = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      call += 1;
      if (call === 1) {
        return sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'apply_sheet_ops', arguments: JSON.stringify({ fingerprint, ops: [{ op: 'setCell', sheet: 'Sales', ref: 'B2', value: 7 }] }) } }] }), chunk({}, 'tool_calls')]);
      }
      return sse([chunk({ role: 'assistant', content: 'B2 已改为 7' }), chunk({}, 'stop')]);
    }) as typeof fetch;
    const posted: HostToEditorMessage[] = [];
    const commits: unknown[] = [];
    let host!: AiChatHost;
    host = new AiChatHost({
      settingsFilePath: path.join(dir, 'settings.json'),
      secretStore: { getApiKey: async () => 'k', setApiKey: async () => undefined, getWebSearchApiKey: async () => null, setWebSearchApiKey: async () => undefined },
      postMessage: (message) => posted.push(message),
      getToolContext: () => ({ workspaceRootPath: dir }),
      fetchImpl,
      officeEdits: {
        showProposal: (_requestId, proposal) => { queueMicrotask(() => host.resolveOfficeEdit(proposal.id, accept)); },
        onCommitted: (_requestId, commit) => { commits.push(commit); },
      },
    });
    await host.handle({ type: 'aiChat.send', requestId: 'r1', mode: 'agent', model: 'm', userMessage: '把 B2 改成 7', attachments: [], history: [], documentFilePath: file, documentFileName: 'book.xlsx' });
    for (let i = 0; i < 200 && !posted.some((m) => m.type === 'aiChat.done' || m.type === 'aiChat.error'); i += 1) await new Promise((r) => setTimeout(r, 10));
    const read = async () => { const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file); return book.getWorksheet('Sales')!.getCell('B2').value; };
    return { host, posted, bodies, commits, read, file };
  }

  it('uses xlsx prompt + tools, writes after Apply, and supports undo', async () => {
    const { host, posted, bodies, commits, read } = await setup(true);
    expect(posted.find((m) => m.type === 'aiChat.error')).toBeUndefined();
    expect(posted.some((m) => m.type === 'aiChat.done')).toBe(true);
    const toolNames = bodies[0].tools.map((t: any) => t.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(['inspect_workbook', 'apply_sheet_ops']));
    expect(toolNames).not.toContain('apply_patch');
    expect(toolNames).not.toContain('create_file');
    expect(bodies[0].messages[0].content).toContain('inspect_workbook');
    expect(await read()).toBe(7);
    expect(commits).toHaveLength(1);
    await host.undoOfficeEdit((commits[0] as { id: string }).id);
    expect(await read()).toBe(3);
  });

  it('leaves the file untouched when the user rejects', async () => {
    const { read, file } = await setup(false);
    const before = await readFile(file);
    expect(await read()).toBe(3);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
  });
  it('refuses an xlsx path outside the workspace', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'easyview-host-xlsx-'));
    const posted: HostToEditorMessage[] = [];
    const host = new AiChatHost({
      settingsFilePath: path.join(dir, 's.json'),
      secretStore: { getApiKey: async () => 'k', setApiKey: async () => undefined, getWebSearchApiKey: async () => null, setWebSearchApiKey: async () => undefined },
      postMessage: (m) => posted.push(m),
      getToolContext: () => ({ workspaceRootPath: path.join(dir, 'ws') }),
      fetchImpl: (async () => { throw new Error('should not call model'); }) as typeof fetch,
      officeEdits: { showProposal: () => undefined },
    });
    await host.handle({ type: 'aiChat.send', requestId: 'r', mode: 'agent', model: 'm', userMessage: 'x', attachments: [], history: [], documentFilePath: path.join(dir, 'other.xlsx') });
    for (let i = 0; i < 100 && !posted.some((m) => m.type === 'aiChat.error'); i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(posted.find((m) => m.type === 'aiChat.error')).toBeDefined();
  });
  it('message flow: relative path, proposal → Apply → committed → undo; external edit before Apply is refused', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'easyview-host-xlsx-'));
    const file = path.join(dir, 'data', 'book.xlsx');
    await import('node:fs/promises').then((fs) => fs.mkdir(path.dirname(file)));
    const write = async (qty: number) => { const book = new ExcelJS.Workbook(); book.addWorksheet('Sales').addRows([['Name', 'Qty'], ['Apple', qty]]); await book.xlsx.writeFile(file); };
    const read = async () => { const book = new ExcelJS.Workbook(); await book.xlsx.readFile(file); return book.getWorksheet('Sales')!.getCell('B2').value; };
    await write(3);
    const posted: HostToEditorMessage[] = [];
    let fingerprint = (await inspectXlsxFile(file)).fingerprint;
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call % 2 === 1) return sse([chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `c${call}`, type: 'function', function: { name: 'apply_sheet_ops', arguments: JSON.stringify({ fingerprint, ops: [{ op: 'setCell', sheet: 'Sales', ref: 'B2', value: 7 }] }) } }] }), chunk({}, 'tool_calls')]);
      return sse([chunk({ role: 'assistant', content: 'ok' }), chunk({}, 'stop')]);
    }) as typeof fetch;
    const host = new AiChatHost({
      settingsFilePath: path.join(dir, 's.json'),
      secretStore: { getApiKey: async () => 'k', setApiKey: async () => undefined, getWebSearchApiKey: async () => null, setWebSearchApiKey: async () => undefined },
      postMessage: (m) => posted.push(m),
      getToolContext: () => ({ workspaceRootPath: dir }),
      fetchImpl,
      officeEdits: {},
    });
    const waitFor = async (predicate: () => boolean) => { for (let i = 0; i < 300 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10)); expect(predicate()).toBe(true); };
    const send = (requestId: string) => host.handle({ type: 'aiChat.send', requestId, mode: 'agent', model: 'm', userMessage: 'B2=7', attachments: [], history: [], documentFilePath: 'data/book.xlsx', documentFileName: 'book.xlsx' });

    // 1) Apply path
    await send('r1');
    await waitFor(() => posted.some((m) => m.type === 'aiChat.officeProposal'));
    const proposal = posted.find((m) => m.type === 'aiChat.officeProposal') as Extract<HostToEditorMessage, { type: 'aiChat.officeProposal' }>;
    expect(proposal.changes).toEqual([{ sheet: 'Sales', ref: 'B2', before: 3, after: 7 }]);
    expect(await read()).toBe(3);
    await host.handle({ type: 'aiChat.officeDecision', requestId: 'r1', proposalId: proposal.proposalId, accepted: true });
    await waitFor(() => posted.some((m) => m.type === 'aiChat.done' && m.requestId === 'r1'));
    const committed = posted.find((m) => m.type === 'aiChat.officeCommitted') as Extract<HostToEditorMessage, { type: 'aiChat.officeCommitted' }>;
    expect(committed.filePath).toBe(file);
    expect(await read()).toBe(7);
    await host.handle({ type: 'aiChat.officeUndo', requestId: 'u1', commitId: committed.commitId });
    expect(posted.find((m) => m.type === 'aiChat.officeUndone')).toMatchObject({ commitId: committed.commitId, filePath: file });
    expect(await read()).toBe(3);

    // 2) File modified externally while the proposal waits → Apply is refused, file keeps the external content
    fingerprint = (await inspectXlsxFile(file)).fingerprint;
    posted.length = 0;
    await send('r2');
    await waitFor(() => posted.some((m) => m.type === 'aiChat.officeProposal'));
    const second = posted.find((m) => m.type === 'aiChat.officeProposal') as Extract<HostToEditorMessage, { type: 'aiChat.officeProposal' }>;
    await write(100);
    await host.handle({ type: 'aiChat.officeDecision', requestId: 'r2', proposalId: second.proposalId, accepted: true });
    await waitFor(() => posted.some((m) => (m.type === 'aiChat.done' || m.type === 'aiChat.error') && m.requestId === 'r2'));
    expect(posted.some((m) => m.type === 'aiChat.officeCommitted')).toBe(false);
    expect(posted.some((m) => m.type === 'aiChat.tool' && m.phase === 'result')).toBe(false);
    expect(await read()).toBe(100);
  });
});

describe('AiChatHost office (docx) agent', () => {
  let dir = '';
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('inspect → apply_docx_ops → user accept-all → undo', async () => {
    const { copyFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { DocxReviewer } = await import('@easyview/docx-agents');
    const { inspectDocxFile } = await import('./docx-edit');

    const load = async (target: string) => {
      const bytes = await readFile(target);
      return DocxReviewer.fromBuffer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        'Test',
      );
    };

    dir = await mkdtemp(path.join(os.tmpdir(), 'easyview-host-docx-'));
    const file = path.join(dir, 'doc.docx');
    const fixture = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../docx-core/test-fixtures/styled-content.docx',
    );
    await copyFile(fixture, file);
    const { fingerprint } = await inspectDocxFile(file);
    const phrase = (await load(file))
      .getContentAsText({ toIndex: 0, includeTrackedChanges: false, includeCommentAnchors: false })
      .replace(/^\[\d+\]\s*/, '')
      .slice(0, 6);
    expect(phrase.length).toBeGreaterThan(0);

    const posted: HostToEditorMessage[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) {
        return sse([
          chunk({
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call1',
              type: 'function',
              function: {
                name: 'apply_docx_ops',
                arguments: JSON.stringify({
                  fingerprint,
                  ops: [
                    { op: 'suggest_change', paragraphIndex: 0, search: phrase, replaceWith: `${phrase}OK` },
                    { op: 'add_comment', paragraphIndex: 0, text: '请核对' },
                  ],
                }),
              },
            }],
          }),
          chunk({}, 'tool_calls'),
        ]);
      }
      return sse([chunk({ role: 'assistant', content: '已提交修订' }), chunk({}, 'stop')]);
    }) as typeof fetch;

    const host = new AiChatHost({
      settingsFilePath: path.join(dir, 'settings.json'),
      secretStore: {
        getApiKey: async () => 'k',
        setApiKey: async () => undefined,
        getWebSearchApiKey: async () => null,
        setWebSearchApiKey: async () => undefined,
      },
      postMessage: (message) => posted.push(message),
      getToolContext: () => ({ workspaceRootPath: dir }),
      fetchImpl,
      officeEdits: {},
    });

    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 300 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(predicate()).toBe(true);
    };

    const before = await readFile(file);
    await host.handle({
      type: 'aiChat.send',
      requestId: 'r1',
      mode: 'agent',
      model: 'm',
      userMessage: '改第一段并加批注',
      attachments: [],
      history: [],
      documentFilePath: 'doc.docx',
      documentFileName: 'doc.docx',
    });
    await waitFor(() => posted.some((m) => m.type === 'aiChat.officeProposal'));
    const proposal = posted.find((m) => m.type === 'aiChat.officeProposal') as Extract<
      HostToEditorMessage,
      { type: 'aiChat.officeProposal' }
    >;
    expect(proposal.kind).toBe('docx');
    expect(proposal.docxChanges?.length).toBe(1);
    expect(proposal.docxComments?.length).toBe(1);
    expect(Buffer.compare(await readFile(file), before)).toBe(0);

    await host.handle({
      type: 'aiChat.officeDecision',
      requestId: 'r1',
      proposalId: proposal.proposalId,
      accepted: true,
      resolution: 'accept-all',
      itemDecisions: [{ index: 0, accept: true }],
    });
    await waitFor(() => posted.some((m) => m.type === 'aiChat.done' && m.requestId === 'r1'));
    const committed = posted.find((m) => m.type === 'aiChat.officeCommitted') as Extract<
      HostToEditorMessage,
      { type: 'aiChat.officeCommitted' }
    >;
    expect(committed.filePath).toBe(file);

    const after = await load(file);
    expect(after.getChanges()).toHaveLength(0);
    expect(after.getContentAsText({ toIndex: 0 })).toContain(`${phrase}OK`);
    expect(after.getComments()).toHaveLength(1);

    await host.handle({ type: 'aiChat.officeUndo', requestId: 'u1', commitId: committed.commitId });
    expect(posted.find((m) => m.type === 'aiChat.officeUndone')).toMatchObject({
      commitId: committed.commitId,
      filePath: file,
    });
    expect(Buffer.compare(await readFile(file), before)).toBe(0);
  });
});
