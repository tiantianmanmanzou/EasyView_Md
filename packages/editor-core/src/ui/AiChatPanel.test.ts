/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorToHostMessage } from '@easyview/contracts';
import { createAiChatPanel, SETTINGS_SAVE_TIMEOUT_MS } from './AiChatPanel';

describe('AiChatPanel host and document context', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="editor-body"></div><aside id="global-ai-host"></aside>';
    window.localStorage.clear();
  });

  it('mounts in the supplied global host and disables Agent outside Markdown', () => {
    const messages: EditorToHostMessage[] = [];
    const host = document.getElementById('global-ai-host')!;
    const panel = createAiChatPanel({
      container: host,
      postMessage: (message) => messages.push(message),
      getDocumentContent: () => '# Document',
      getFilePath: () => '/workspace/document.md',
      getFileName: () => 'document.md',
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });

    const root = host.querySelector<HTMLElement>('.ai-chat-panel');
    expect(root).not.toBeNull();
    panel.open();
    expect(root?.classList.contains('hidden')).toBe(false);
    expect(messages.some((message) => message.type === 'aiChat.getSettings')).toBe(true);

    panel.setDocumentContextAvailable(false);
    panel.setFilePath('');
    const agent = root?.querySelector<HTMLButtonElement>('[data-mode="agent"]');
    expect(agent?.disabled).toBe(true);
    expect(agent?.title).toContain('仅 Markdown');
    expect(agent?.title).toContain('.xlsx');
    expect(agent?.title).toContain('.docx');
    expect(root?.querySelector('[data-mode="chat"]')?.classList.contains('active')).toBe(true);

    panel.setDocumentContextAvailable(true);
    panel.setFilePath('/workspace/document.md');
    expect(agent?.disabled).toBe(false);
    panel.destroy();
    expect(host.querySelector('.ai-chat-panel')).toBeNull();
  });

  it('starts in Agent mode and returns to it once a document is available again', () => {
    const host = document.getElementById('global-ai-host')!;
    const panel = createAiChatPanel({
      container: host,
      postMessage: () => undefined,
      getDocumentContent: () => '# Document',
      getFilePath: () => '/workspace/document.md',
      getFileName: () => 'document.md',
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });
    const active = () => host.querySelector('.ai-chat-mode-btn.active')?.getAttribute('data-mode');
    expect(active()).toBe('agent');
    panel.setDocumentContextAvailable(false);
    expect(active()).toBe('chat');
    panel.setDocumentContextAvailable(true);
    expect(active()).toBe('agent');
    panel.destroy();
  });

  it('picks the mode from a dropdown beside the model, defaulting to Agent over a stored preference of chat only after the user chooses Chat', () => {
    const host = document.getElementById('global-ai-host')!;
    const create = () => createAiChatPanel({
      container: host,
      postMessage: () => undefined,
      getDocumentContent: () => '# Document',
      getFilePath: () => '/workspace/document.md',
      getFileName: () => 'document.md',
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });
    let panel = create();
    const picker = host.querySelector('.ai-chat-mode-picker')!;
    expect(picker.previousElementSibling?.classList.contains('ai-chat-model-switcher')).toBe(true);
    expect(host.querySelector('.ai-chat-header .ai-chat-mode-btn')).toBeNull();
    expect(host.querySelector('.ai-chat-header .ai-chat-panel-icon')?.getAttribute('title')).toBe('AI 对话');
    expect(host.querySelector('.ai-chat-title')).toBeNull();
    expect(host.querySelector('.ai-chat-mode-label')?.textContent).toBe('Agent');
    expect(host.querySelector('[data-action="history"]')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('.ai-chat-mode-current')!.click();
    expect(host.querySelector('.ai-chat-mode-menu')?.classList.contains('open')).toBe(true);
    host.querySelector<HTMLButtonElement>('.ai-chat-mode-option[data-mode="chat"]')!.click();
    expect(host.querySelector('.ai-chat-mode-menu')?.classList.contains('open')).toBe(false);
    expect(host.querySelector('.ai-chat-mode-label')?.textContent).toBe('Chat');
    panel.destroy();

    panel = create();
    expect(host.querySelector('.ai-chat-mode-label')?.textContent).toBe('Chat');
    panel.destroy();
  });

  it('shows all tool calls of a reply on one line above the answer', () => {
    const messages: EditorToHostMessage[] = [];
    const host = document.getElementById('global-ai-host')!;
    const panel = createAiChatPanel({
      container: host,
      postMessage: (message) => messages.push(message),
      getDocumentContent: () => '# Document',
      getFilePath: () => '/workspace/document.md',
      getFileName: () => 'document.md',
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });
    panel.open();
    const settingsRequest = messages.find((message) => message.type === 'aiChat.getSettings') as { requestId: string };
    panel.handleMessage({
      type: 'aiChat.settingsResponse',
      requestId: settingsRequest.requestId,
      settings: { baseUrl: 'https://api.example.com', models: ['m'], defaultModel: 'm' } as never,
      hasApiKey: true,
      hasWebSearchApiKey: false,
    });
    host.querySelector<HTMLTextAreaElement>('.ai-chat-input')!.value = 'check the doc';
    host.querySelector<HTMLButtonElement>('.ai-chat-send-btn')!.click();
    const send = messages.find((message) => message.type === 'aiChat.send') as { requestId: string } | undefined;
    expect(send).toBeDefined();
    const tool = (phase: 'call' | 'result', toolName: string) => panel.handleMessage({ type: 'aiChat.tool', requestId: send!.requestId, phase, toolName, input: {} });
    tool('call', 'list_files');
    tool('result', 'list_files');
    tool('call', 'read_file');
    tool('result', 'read_file');
    tool('call', 'read_file');

    const reply = [...host.querySelectorAll('.ai-chat-msg.assistant')].at(-1)!;
    const line = reply.querySelector('.ai-chat-tool-line')!;
    expect(host.querySelectorAll('.ai-chat-tool-line')).toHaveLength(1);
    expect(line.textContent).toBe('工具调用 3 次：list_files · read_file ×2');
    expect(line.classList.contains('running')).toBe(true);
    expect(line.compareDocumentPosition(reply.querySelector('.ai-chat-bubble')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    tool('result', 'read_file');
    expect(host.querySelector('.ai-chat-tool-line')!.classList.contains('running')).toBe(false);
    panel.destroy();
  });

  describe('settings save', () => {
    afterEach(() => vi.useRealTimers());
    const setup = () => {
      const messages: EditorToHostMessage[] = [];
      const host = document.getElementById('global-ai-host')!;
      const panel = createAiChatPanel({
        container: host, postMessage: (message) => messages.push(message),
        getDocumentContent: () => '', getFilePath: () => '', getFileName: () => '', applyDocumentEdit: () => undefined, copyText: () => undefined,
      });
      host.querySelector<HTMLButtonElement>('[data-action="settings"]')!.click();
      const dialog = document.querySelector<HTMLElement>('.easyview-settings-dialog')!;
      const [models] = dialog.querySelectorAll<HTMLTextAreaElement>('textarea');
      const [temperature, topP, maxTokens] = dialog.querySelectorAll<HTMLInputElement>('input[type="number"]');
      const [apiKey, webSearchKey] = dialog.querySelectorAll<HTMLInputElement>('input[type="password"]');
      models.value = 'deepseek-chat\ndeepseek-reasoner';
      temperature.value = '0.7'; topP.value = '1'; maxTokens.value = '4096';
      apiKey.value = 'test-key'; webSearchKey.value = '';
      return {
        messages, panel, dialog,
        error: () => dialog.querySelector<HTMLElement>('.easyview-settings-error')!,
        save: dialog.querySelector<HTMLButtonElement>('.easyview-settings-footer .is-primary')!,
      };
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    it('opens the shared settings dialog with short labels and the keychain note', () => {
      const { panel, dialog } = setup();
      expect([...dialog.querySelectorAll('.easyview-settings-label')].map((label) => label.textContent))
        .toEqual(['API Key', 'Brave Search API Key', 'Base URL', '模型列表', 'Temperature', 'Top P', 'Max Tokens', '系统提示词', '输出']);
      expect(dialog.querySelector('.easyview-settings-note')?.textContent).toContain('钥匙串');
      panel.destroy();
      document.querySelector('.easyview-settings-overlay')?.remove();
    });
    it('waits for settings and key replies, skips an empty optional key, and reports key errors', async () => {
      const { messages, panel, error, save } = setup();
      save.click();
      const saves = messages.filter((m) => m.type === 'aiChat.saveSettings' || m.type === 'aiChat.saveApiKey' || m.type === 'aiChat.saveWebSearchApiKey');
      expect(saves.map((m) => m.type)).toEqual(['aiChat.saveSettings', 'aiChat.saveApiKey']);
      expect(save.disabled).toBe(true);
      const id = (m: EditorToHostMessage) => (m as { requestId: string }).requestId;
      panel.handleMessage({ type: 'aiChat.settingsSaved', requestId: 'someone-else', ok: true });
      panel.handleMessage({ type: 'aiChat.settingsSaved', requestId: id(saves[0]), ok: true });
      await flush();
      expect(save.disabled).toBe(true);
      panel.handleMessage({ type: 'aiChat.settingsSaved', requestId: id(saves[1]), ok: false, message: 'Keychain denied' });
      await flush();
      expect(error().textContent).toBe('Keychain denied'); expect(save.disabled).toBe(false);
      panel.handleMessage({ type: 'aiChat.settingsSaved', requestId: 'x', ok: true });
      save.click();
      const retry = messages.filter((m) => m.type === 'aiChat.saveSettings' || m.type === 'aiChat.saveApiKey').slice(-2);
      for (const message of retry) panel.handleMessage({ type: 'aiChat.settingsSaved', requestId: id(message), ok: true });
      await flush();
      expect(document.querySelector('.easyview-settings-overlay')).toBeNull();
      panel.destroy();
    });
    it('keeps the dialog open with an error for invalid values', () => {
      const { messages, panel, dialog, error, save } = setup();
      dialog.querySelector<HTMLTextAreaElement>('textarea')!.value = '  ';
      save.click();
      expect(error().textContent).toBe('模型列表不能为空');
      expect(messages.some((m) => m.type === 'aiChat.saveSettings')).toBe(false);
      panel.destroy();
      document.querySelector('.easyview-settings-overlay')?.remove();
    });
    it('times out instead of staying at "Saving…" forever', async () => {
      vi.useFakeTimers();
      const { panel, error, save } = setup();
      save.click();
      vi.advanceTimersByTime(SETTINGS_SAVE_TIMEOUT_MS + 1);
      await vi.runAllTimersAsync();
      expect(error().textContent).toContain('保存超时');
      expect(save.disabled).toBe(false);
      panel.destroy();
      document.querySelector('.easyview-settings-overlay')?.remove();
    });
  });
});

describe('AI conversation lifetime', () => {
  function setup(applyDocumentEdit: (content: string) => void | Promise<void> = () => undefined) {
    document.body.innerHTML = '<div id="editor-body"></div>';
    window.localStorage.clear();
    const sent: EditorToHostMessage[] = [];
    const panel = createAiChatPanel({ postMessage: message => sent.push(message), getDocumentContent: () => 'original', getFilePath: () => '/audit.md', getFileName: () => 'audit.md', applyDocumentEdit, copyText: () => undefined });
    panel.open();
    const request = sent.find(message => message.type === 'aiChat.getSettings')! as { requestId: string };
    panel.handleMessage({ type: 'aiChat.settingsResponse', requestId: request.requestId, settings: { baseUrl: '', models: ['test'], defaultModel: 'test', temperature: 1, topP: 1, maxTokens: 100, systemPrompt: '', stream: true }, hasApiKey: true, hasWebSearchApiKey: false });
    return { panel, sent, send(text: string) {
      document.querySelector<HTMLTextAreaElement>('.ai-chat-input')!.value = text;
      document.querySelector<HTMLButtonElement>('.ai-chat-send-btn')!.click();
      return (sent.filter(message => message.type === 'aiChat.send').at(-1)! as { requestId: string }).requestId;
    } };
  }
  it('bounds retained messages, pages earlier rows, and reuses completed reply DOM', () => {
    const { panel, send } = setup();
    let id = send('first'); panel.handleMessage({ type: 'aiChat.done', requestId: id, content: 'answer', finishReason: 'stop' });
    const row = document.querySelector('.ai-chat-msg.assistant');
    id = send('second'); panel.handleMessage({ type: 'aiChat.done', requestId: id, content: 'answer 2', finishReason: 'stop' });
    expect(document.querySelector('.ai-chat-msg.assistant')).toBe(row);
    for (let i = 2; i < 105; i++) {
      id = send(`message ${i}`); panel.handleMessage({ type: 'aiChat.done', requestId: id, content: `answer ${i}`, finishReason: 'stop' });
    }
    expect(document.querySelectorAll('.ai-chat-msg')).toHaveLength(80);
    const activeId = localStorage.getItem('easyview-ai-chat-active-thread')!;
    expect(JSON.parse(localStorage.getItem(`easyview-ai-chat-thread:${activeId}`)!).messages).toHaveLength(200);
    document.querySelector<HTMLButtonElement>('.ai-chat-earlier')!.click();
    expect(document.querySelectorAll('.ai-chat-msg')).toHaveLength(160);
    panel.destroy();
  });

  it('keeps the conversation when the focused file changes, and history can jump back', () => {
    let path = '/a.md';
    document.body.innerHTML = '<div id="editor-body"></div>';
    window.localStorage.clear();
    const sent: EditorToHostMessage[] = [];
    const panel = createAiChatPanel({
      postMessage: (message) => sent.push(message),
      getDocumentContent: () => 'doc',
      getFilePath: () => path,
      getFileName: () => path.split('/').pop()!,
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });
    panel.open();
    const settingsReq = sent.find((message) => message.type === 'aiChat.getSettings')! as { requestId: string };
    panel.handleMessage({
      type: 'aiChat.settingsResponse',
      requestId: settingsReq.requestId,
      settings: { baseUrl: '', models: ['test'], defaultModel: 'test', temperature: 1, topP: 1, maxTokens: 100, systemPrompt: '', stream: true },
      hasApiKey: true,
      hasWebSearchApiKey: false,
    });
    document.querySelector<HTMLTextAreaElement>('.ai-chat-input')!.value = 'first thread';
    document.querySelector<HTMLButtonElement>('.ai-chat-send-btn')!.click();
    const firstId = (sent.filter((message) => message.type === 'aiChat.send').at(-1)! as { requestId: string }).requestId;
    panel.handleMessage({ type: 'aiChat.done', requestId: firstId, content: 'answer one', finishReason: 'stop' });
    expect(document.querySelector('.ai-chat-msg.user')!.textContent).toContain('first thread');

    path = '/b.md';
    panel.setFilePath('/b.md');
    expect(document.querySelector('.ai-chat-msg.user')!.textContent).toContain('first thread');

    document.querySelector<HTMLButtonElement>('[data-action="new-chat"]')!.click();
    expect(document.querySelector('.ai-chat-msg')).toBeNull();
    document.querySelector<HTMLTextAreaElement>('.ai-chat-input')!.value = 'second thread';
    document.querySelector<HTMLButtonElement>('.ai-chat-send-btn')!.click();
    const secondId = (sent.filter((message) => message.type === 'aiChat.send').at(-1)! as { requestId: string }).requestId;
    panel.handleMessage({ type: 'aiChat.done', requestId: secondId, content: 'answer two', finishReason: 'stop' });

    document.querySelector<HTMLButtonElement>('[data-action="history"]')!.click();
    expect(document.querySelector('[data-history-panel]')!.classList.contains('open')).toBe(true);
    const items = document.querySelectorAll<HTMLButtonElement>('.ai-chat-history-item');
    expect(items.length).toBeGreaterThanOrEqual(2);
    items[items.length - 1]!.click(); // older first thread (list is newest-first)
    expect(document.querySelector('.ai-chat-msg.user')!.textContent).toContain('first thread');
    expect(document.querySelector('[data-history-panel]')!.classList.contains('open')).toBe(false);
    panel.destroy();
  });

  it('migrates legacy per-file history into unbound threads', () => {
    window.localStorage.clear();
    window.localStorage.setItem(
      'easyview-ai-chat-history:/workspace/old.md',
      JSON.stringify({ version: 1, mode: 'agent', messages: [{ role: 'user', content: 'legacy hello' }, { role: 'assistant', content: 'legacy reply' }] }),
    );
    document.body.innerHTML = '<div id="editor-body"></div>';
    const panel = createAiChatPanel({
      postMessage: () => undefined,
      getDocumentContent: () => '#',
      getFilePath: () => '/workspace/other.md',
      getFileName: () => 'other.md',
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });
    expect(window.localStorage.getItem('easyview-ai-chat-history:/workspace/old.md')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('easyview-ai-chat-threads')!).length).toBe(1);
    expect(document.body.querySelector('.ai-chat-msg.user')?.textContent ?? '').toContain('legacy hello');
    panel.setFilePath('/workspace/another.md');
    expect(document.body.querySelector('.ai-chat-msg.user')?.textContent ?? '').toContain('legacy hello');
    panel.destroy();
  });
  it('acknowledges a background edit only after its document accepts it', async () => {
    let accept!: () => void;
    const applied = vi.fn(() => new Promise<void>(resolve => { accept = resolve; }));
    const { panel, sent, send } = setup(applied);
    const requestId = send('edit'); panel.setSuspended(true);
    panel.handleMessage({ type: 'aiChat.applyPatches', requestId, operationId: 'edit-1', path: '/audit.md', patches: [{ description: 'edit', expectedText: 'original', replacement: 'changed' }] });
    expect(applied).toHaveBeenCalledWith('changed');
    expect(sent.some(message => message.type === 'aiChat.patchesApplied')).toBe(false);
    accept(); await Promise.resolve(); await Promise.resolve();
    expect(sent).toContainEqual({ type: 'aiChat.patchesApplied', requestId, operationId: 'edit-1', error: undefined });
    panel.destroy();
  });
  it('reports a patch conflict instead of acknowledging a successful edit', async () => {
    const applied = vi.fn(); const { panel, sent, send } = setup(applied); const requestId = send('edit');
    panel.handleMessage({ type: 'aiChat.applyPatches', requestId, operationId: 'conflict', path: '/audit.md', patches: [{ description: 'edit', expectedText: 'missing anchor', replacement: 'changed' }] });
    await Promise.resolve(); await Promise.resolve();
    expect(applied).not.toHaveBeenCalled();
    expect(sent.find(message => message.type === 'aiChat.patchesApplied')).toMatchObject({ operationId: 'conflict', error: expect.any(String) });
    panel.destroy();
  });
  it('shows an xlsx cell diff, writes only on Apply, and offers Undo', () => {
    const { panel, sent, send } = setup();
    const requestId = send('把 B2 改成 7');
    panel.handleMessage({ type: 'aiChat.officeProposal', requestId, proposalId: 'p1', fileName: 'book.xlsx', changes: [{ sheet: 'Sales', ref: 'B2', before: 3, after: 7 }], total: 1, structural: [], truncated: false });
    const box = document.querySelector('.ai-chat-office-edit')!;
    expect(box.textContent).toContain('book.xlsx');
    expect(box.querySelector('td.before')!.textContent).toBe('3');
    expect(box.querySelector('td.after')!.textContent).toBe('7');
    expect(sent.some((m) => m.type === 'aiChat.officeDecision')).toBe(false);
    document.querySelector<HTMLButtonElement>('.ai-chat-office-btn.apply')!.click();
    expect(sent).toContainEqual({ type: 'aiChat.officeDecision', requestId, proposalId: 'p1', accepted: true });
    panel.handleMessage({ type: 'aiChat.officeCommitted', requestId, commitId: 'p1', filePath: '/ws/book.xlsx', backup: 'git show refs/easyview/ai-backups/x' });
    panel.handleMessage({ type: 'aiChat.done', requestId, content: 'B2 已改为 7', finishReason: 'stop' });
    document.querySelector<HTMLButtonElement>('.ai-chat-office-btn.undo')!.click();
    const undo = sent.find((m) => m.type === 'aiChat.officeUndo') as { requestId: string; commitId: string };
    expect(undo.commitId).toBe('p1');
    panel.handleMessage({ type: 'aiChat.officeUndone', requestId: undo.requestId, commitId: 'p1', filePath: '/ws/book.xlsx' });
    expect(document.querySelector('.ai-chat-office-edit')!.classList.contains('undone')).toBe(true);
    expect(document.querySelector('.ai-chat-office-btn')).toBeNull();
    panel.destroy();
  });
  it('rejecting a proposal sends a negative decision and keeps no buttons', () => {
    const { panel, sent, send } = setup();
    const requestId = send('改');
    panel.handleMessage({ type: 'aiChat.officeProposal', requestId, proposalId: 'p2', fileName: 'b.xlsx', changes: [{ sheet: 'S', ref: 'A1', before: null, after: 'x' }], total: 1, structural: ['S: +1 row(s) at 2'], truncated: false });
    document.querySelector<HTMLButtonElement>('.ai-chat-office-btn.reject')!.click();
    expect(sent).toContainEqual({ type: 'aiChat.officeDecision', requestId, proposalId: 'p2', accepted: false });
    expect(document.querySelector('.ai-chat-office-edit')!.classList.contains('rejected')).toBe(true);
    expect(document.querySelector('.ai-chat-office-btn')).toBeNull();
    panel.destroy();
  });
  it('summarizes a large proposal and renders only the first 50 rows', () => {
    const { panel, send } = setup();
    const requestId = send('全部单价上调 10%');
    const changes = Array.from({ length: 1000 }, (_, i) => ({ sheet: 'S', ref: `C${i + 2}`, before: i, after: i * 1.1 }));
    panel.handleMessage({ type: 'aiChat.officeProposal', requestId, proposalId: 'big', fileName: 'big.xlsx', changes, total: 30000, structural: [], truncated: true });
    const box = document.querySelector('.ai-chat-office-edit')!;
    expect(box.querySelectorAll('tbody tr')).toHaveLength(50);
    expect(box.querySelector('.ai-chat-office-title')!.textContent).toContain('共 30000 处');
    expect(box.querySelector('.ai-chat-office-more')!.textContent).toBe('共 30000 处修改，仅显示前 50 处');
    panel.destroy();
  });

  it('docx proposal: per-item reject + write as revisions, or accept-all into body', () => {
    const { panel, sent, send } = setup();
    const requestId = send('改合同措辞');
    panel.handleMessage({
      type: 'aiChat.officeProposal',
      requestId,
      proposalId: 'd1',
      fileName: 'contract.docx',
      kind: 'docx',
      changes: [
        { sheet: '¶0', ref: '甲方', before: '甲方', after: '委托方' },
        { sheet: '¶1', ref: '乙方', before: '乙方', after: '受托方' },
      ],
      total: 2,
      structural: [],
      truncated: false,
      docxChanges: [
        { index: 0, paragraphIndex: 0, search: '甲方', replaceWith: '委托方', before: '甲方', after: '委托方' },
        { index: 1, paragraphIndex: 1, search: '乙方', replaceWith: '受托方', before: '乙方', after: '受托方' },
      ],
      docxComments: [{ paragraphIndex: 0, text: '请法务确认' }],
    });
    const box = document.querySelector('.ai-chat-office-edit')!;
    expect(box.querySelector('.ai-chat-office-title')!.textContent).toContain('contract.docx');
    expect(box.querySelector('.ai-chat-office-title')!.textContent).toContain('2 处修订');
    expect(box.querySelector('.ai-chat-office-title')!.textContent).toContain('1 条批注');
    expect(box.querySelector('.ai-chat-office-status')!.textContent).toContain('写入修订');
    expect(box.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(box.querySelector('.ai-chat-office-btn.accept-all')).not.toBeNull();
    expect(box.querySelector('.ai-chat-office-btn.apply')).not.toBeNull();

    const rejectButtons = box.querySelectorAll<HTMLButtonElement>('.ai-chat-office-item-actions button');
    // each row: Accept + Reject
    expect(rejectButtons.length).toBe(4);
    rejectButtons[3]!.click(); // reject second revision
    expect(document.querySelectorAll('tr.ai-chat-office-row-rejected')).toHaveLength(1);

    document.querySelector<HTMLButtonElement>('.ai-chat-office-btn.apply')!.click();
    expect(sent).toContainEqual({
      type: 'aiChat.officeDecision',
      requestId,
      proposalId: 'd1',
      accepted: true,
      resolution: 'tracked',
      itemDecisions: [
        { index: 0, accept: true },
        { index: 1, accept: false },
      ],
    });
    panel.destroy();
  });

  it('docx accept-all forces every revision on and writes resolution accept-all', () => {
    const { panel, sent, send } = setup();
    const requestId = send('全部接受');
    panel.handleMessage({
      type: 'aiChat.officeProposal',
      requestId,
      proposalId: 'd2',
      fileName: 'a.docx',
      kind: 'docx',
      changes: [{ sheet: '¶0', ref: 'x', before: 'x', after: 'y' }],
      total: 1,
      structural: [],
      truncated: false,
      docxChanges: [
        { index: 0, paragraphIndex: 0, search: 'x', replaceWith: 'y', before: 'x', after: 'y' },
      ],
      docxComments: [],
    });
    // Mark rejected first, then accept-all should still send accept:true for all.
    document.querySelectorAll<HTMLButtonElement>('.ai-chat-office-item-actions button')[1]!.click();
    document.querySelector<HTMLButtonElement>('.ai-chat-office-btn.accept-all')!.click();
    expect(sent).toContainEqual({
      type: 'aiChat.officeDecision',
      requestId,
      proposalId: 'd2',
      accepted: true,
      resolution: 'accept-all',
      itemDecisions: [{ index: 0, accept: true }],
    });
    panel.destroy();
  });
});
