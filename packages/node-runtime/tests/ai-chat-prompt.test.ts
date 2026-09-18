import { describe, expect, it } from 'vitest';
import { buildAiChatMessages, MAX_DOCUMENT_CONTEXT_CHARS } from '../src/ai/chatPrompt';

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

  it('agent mode: document content is injected into the system message', () => {
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
    expect(system).toContain('COMPLETE updated document');
    expect(system).toContain('当前文档: notes.md');
    expect(system).toContain('# Title');
  });

  it('truncates oversized documents', () => {
    const big = 'a'.repeat(MAX_DOCUMENT_CONTEXT_CHARS + 5000);
    const messages = buildAiChatMessages({
      systemPrompt: '',
      mode: 'agent',
      history: [],
      userMessage: '改一下',
      attachments: [],
      documentContent: big,
    });
    const system = messages[0].content as string;
    expect(system.length).toBeLessThan(MAX_DOCUMENT_CONTEXT_CHARS + 1000);
    expect(system).toContain('已截断');
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
});
