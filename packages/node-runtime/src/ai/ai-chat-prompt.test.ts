import { describe, expect, it } from 'vitest';
import { buildAiChatMessages } from './chatPrompt';

describe('buildAiChatMessages', () => {
  it('chat mode: base system instruction + custom prompt + history + user text', () => {
    const messages = buildAiChatMessages({
      systemPrompt: '只回答中文',
      mode: 'chat',
      history: [
        { role: 'user', content: '问题一' },
        { role: 'assistant', content: '回答一' },
      ],
      userMessage: '问题二',
      attachments: [],
    });
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Markdown editor');
    expect(messages[0].content).toContain('只回答中文');
    expect(messages[0].content).not.toContain('当前文档');
    expect(messages[1]).toEqual({ role: 'user', content: '问题一' });
    expect(messages[2]).toEqual({ role: 'assistant', content: '回答一' });
    expect(messages[3]).toEqual({ role: 'user', content: '问题二' });
  });

  it('agent mode requires an inspect_file baseline instead of injecting document content', () => {
    const messages = buildAiChatMessages({
      systemPrompt: '',
      mode: 'agent',
      history: [],
      userMessage: '把标题改成大写',
      attachments: [],
      documentContent: '# Title\n\n正文',
      documentFileName: 'notes.md',
    });
    expect(messages).toHaveLength(2);
    const system = messages[0].content as string;
    expect(system).toContain('inspect_file');
    expect(system).toContain('apply_patch');
    expect(system).not.toContain('COMPLETE updated document');
    expect(system).toContain('当前打开文档: notes.md');
    expect(system).toContain('不带 path 的 inspect_file');
    expect(system).not.toContain('# Title');
  });

  it('builds multimodal parts when attachments are present', () => {
    const messages = buildAiChatMessages({
      systemPrompt: '',
      mode: 'chat',
      history: [],
      userMessage: '这张图是什么',
      attachments: [
        { source: 'upload', name: 'shot.png', url: 'data:image/png;base64,AAA' },
        { source: 'url', name: 'remote', url: 'https://example.com/a.png' },
      ],
    });
    const last = messages[messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts[0]).toEqual({ type: 'text', text: '这张图是什么' });
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    expect(parts[2]).toEqual({ type: 'image_url', image_url: { url: 'https://example.com/a.png' } });
  });

  it('empty user message with attachment still produces an image part', () => {
    const messages = buildAiChatMessages({
      systemPrompt: '',
      mode: 'chat',
      history: [],
      userMessage: '',
      attachments: [{ source: 'url', name: 'img', url: 'https://example.com/b.png' }],
    });
    const parts = messages[messages.length - 1].content as Array<{ type: string }>;
    expect(parts).toEqual([{ type: 'image_url', image_url: { url: 'https://example.com/b.png' } }]);
  });
  it('xlsx agent mode uses workbook instructions instead of text patch rules', () => {
    const messages = buildAiChatMessages({ systemPrompt: '', mode: 'agent', history: [], userMessage: '汇总', attachments: [], documentFileName: 'sales.xlsx', documentKind: 'xlsx' });
    const system = messages[0].content as string;
    expect(system).toContain('inspect_workbook');
    expect(system).toContain('apply_sheet_ops');
    expect(system).toContain('sales.xlsx');
    expect(system).not.toContain('apply_patch');
  });
  it('docx agent mode uses body-edit instructions instead of text patch rules', () => {
    const messages = buildAiChatMessages({ systemPrompt: '', mode: 'agent', history: [], userMessage: '改合同', attachments: [], documentFileName: 'contract.docx', documentKind: 'docx' });
    const system = messages[0].content as string;
    expect(system).toContain('inspect_document');
    expect(system).toContain('apply_docx_ops');
    expect(system).toContain('contract.docx');
    expect(system).toContain('replace_text');
    expect(system).not.toContain('apply_patch');
  });
  it('pptx agent mode uses slide-edit instructions instead of text patch rules', () => {
    const messages = buildAiChatMessages({ systemPrompt: '', mode: 'agent', history: [], userMessage: '改标题', attachments: [], documentFileName: 'deck.pptx', documentKind: 'pptx' });
    const system = messages[0].content as string;
    expect(system).toContain('inspect_presentation');
    expect(system).toContain('apply_slide_ops');
    expect(system).toContain('deck.pptx');
    expect(system).toContain('replaceText');
    expect(system).not.toContain('apply_patch');
  });
});
