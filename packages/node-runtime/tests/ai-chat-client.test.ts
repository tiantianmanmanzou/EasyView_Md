import { tool } from 'ai';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import {
  OpenAiChatError,
  streamOpenAiChat,
  type OpenAiChatRequestOptions,
} from '../src/ai/openai-chat-client';

function sseResponse(chunks: string[], options: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream', ...options.headers },
  });
}

function baseOptions(fetchImpl: typeof fetch, overrides: Partial<OpenAiChatRequestOptions> = {}): OpenAiChatRequestOptions {
  return {
    baseUrl: 'https://api.deepseek.com/',
    apiKey: 'sk-test',
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl,
    inactivityTimeoutMs: 1_000,
    totalTimeoutMs: 5_000,
    ...overrides,
  };
}

describe('streamOpenAiChat (Vercel AI SDK)', () => {
  it('streams text and reasoning through the OpenAI-compatible provider', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"你"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"r1","content":"好"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const events: string[] = [];

    const result = await streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch), (event) => {
      if (event.type !== 'delta') return;
      events.push(event.text ?? `<r:${event.reasoning}>`);
    });

    expect(result).toEqual({ content: '你好', reasoning: 'r1', finishReason: 'stop' });
    expect(events).toEqual(['你', '<r:r1>', '好']);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'deepseek-chat', stream: true });
  });

  it('uses a non-streaming AI SDK request when streaming is disabled', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"choices":[{"message":{"content":"答案","reasoning_content":"原因"},"finish_reason":"stop"}]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch, { stream: false }), () => undefined))
      .resolves.toEqual({ content: '答案', reasoning: '原因', finishReason: 'stop' });
    const [, request] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(JSON.parse(request.body as string)).not.toHaveProperty('stream');
  });

  it('maps OpenAI-compatible HTTP errors to existing chat error codes', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"error":{"message":"bad key"}}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch), () => undefined))
      .rejects.toMatchObject({ code: 'AUTH', status: 401 });
  });

  it('keeps image attachments as OpenAI image_url content through the provider adapter', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );

    await streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch, {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
    }), () => undefined);

    const [, request] = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    const body = JSON.parse(request.body as string);
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'describe image' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });

  it('runs an OpenAI-compatible tool loop and exposes tool events', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(sseResponse([
        'data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"lookup\",\"arguments\":\"{\\\"query\\\":\\\"EasyView\\\"}\"}}]}}]}\n\n',
        'data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n',
        'data: [DONE]\n\n',
      ]))
      .mockResolvedValueOnce(sseResponse([
        'data: {\"choices\":[{\"delta\":{\"content\":\"搜索完成\"}}]}\n\n',
        'data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
    const events: Array<{ type: string; toolName?: string }> = [];

    const result = await streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch, {
      tools: {
        lookup: tool({
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => ({ query, result: 'EasyView_Md' }),
        }),
      },
    }), (event) => events.push({ type: event.type, toolName: event.type === 'delta' ? undefined : event.toolName }));

    expect(result).toEqual({ content: '搜索完成', reasoning: undefined, finishReason: 'stop' });
    expect(events).toContainEqual({ type: 'tool-call', toolName: 'lookup' });
    expect(events).toContainEqual({ type: 'tool-result', toolName: 'lookup' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates caller cancellation as an aborted chat error', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const controller = new AbortController();
    const pending = streamOpenAiChat(
      baseOptions(fetchImpl as unknown as typeof fetch, { signal: controller.signal }),
      () => undefined,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' } satisfies Partial<OpenAiChatError>);
  });

  it('enforces the total timeout through the AI SDK request abort signal', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    await expect(streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch, { totalTimeoutMs: 30 }), () => undefined))
      .rejects.toMatchObject({ code: 'TIMEOUT' } satisfies Partial<OpenAiChatError>);
  });
});
