import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiChatHost } from '../src/ai/ai-chat-host';
import { DEFAULT_AI_CHAT_SETTINGS } from '@easyview/contracts';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('AiChatHost', () => {
  let tempDir = '';

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('loads default settings and reports missing api key', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'easyview-ai-chat-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    const posted: unknown[] = [];
    const host = new AiChatHost({
      settingsFilePath: settingsPath,
      secretStore: {
        getApiKey: async () => null,
        setApiKey: async () => undefined,
      },
      postMessage: (message) => {
        posted.push(message);
      },
    });

    await host.handle({ type: 'aiChat.getSettings', requestId: 'req-1' });
    expect(posted).toEqual([
      {
        type: 'aiChat.settingsResponse',
        requestId: 'req-1',
        settings: DEFAULT_AI_CHAT_SETTINGS,
        hasApiKey: false,
      },
    ]);
  });

  it('persists settings and api key', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'easyview-ai-chat-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    let apiKey = '';
    const posted: unknown[] = [];
    const host = new AiChatHost({
      settingsFilePath: settingsPath,
      secretStore: {
        getApiKey: async () => apiKey,
        setApiKey: async (value) => {
          apiKey = value;
        },
      },
      postMessage: (message) => {
        posted.push(message);
      },
    });

    await host.handle({
      type: 'aiChat.saveSettings',
      requestId: 'save-settings',
      settings: { ...DEFAULT_AI_CHAT_SETTINGS, temperature: 0.7 },
    });
    await host.handle({ type: 'aiChat.saveApiKey', requestId: 'save-key', apiKey: 'sk-test' });

    const saved = JSON.parse(await readFile(settingsPath, 'utf8')) as { temperature: number };
    expect(saved.temperature).toBe(0.7);
    expect(apiKey).toBe('sk-test');
    expect(posted).toContainEqual({
      type: 'aiChat.settingsSaved',
      requestId: 'save-settings',
      ok: true,
      message: '已保存',
    });
  });

  it('streams chat completion deltas and done', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'easyview-ai-chat-'));
    const settingsPath = path.join(tempDir, 'settings.json');
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const posted: unknown[] = [];
    let finished: (() => void) | undefined;
    const donePromise = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const host = new AiChatHost({
      settingsFilePath: settingsPath,
      secretStore: {
        getApiKey: async () => 'sk-test',
        setApiKey: async () => undefined,
      },
      postMessage: (message) => {
        posted.push(message);
        if (message.type === 'aiChat.done' || message.type === 'aiChat.error') {
          finished?.();
        }
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await host.handle({
      type: 'aiChat.send',
      requestId: 'chat-1',
      mode: 'chat',
      model: 'deepseek-chat',
      userMessage: 'hi',
      attachments: [],
      history: [],
    });
    await donePromise;

    expect(posted).toContainEqual({
      type: 'aiChat.delta',
      requestId: 'chat-1',
      text: '你',
      reasoning: undefined,
    });
    expect(posted).toContainEqual({
      type: 'aiChat.done',
      requestId: 'chat-1',
      content: '你好',
      reasoning: undefined,
      finishReason: 'stop',
    });
  });
});
