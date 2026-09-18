import { describe, expect, it, vi } from 'vitest';
import {
  OpenAiChatError,
  createSseDataParser,
  parseChatCompletionChunk,
  parseChatCompletionResponse,
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

describe('createSseDataParser', () => {
  it('parses complete lines and skips comments', () => {
    const parse = createSseDataParser();
    expect(parse('data: {"a":1}\n: keepalive\ndata: {"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles lines split across chunks', () => {
    const parse = createSseDataParser();
    expect(parse('data: {"par')).toEqual([]);
    expect(parse('tial":"x"}\n')).toEqual(['{"partial":"x"}']);
  });

  it('handles CRLF line endings', () => {
    const parse = createSseDataParser();
    expect(parse('data: {"a":1}\r\ndata: {"b":2}\r\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('tolerates missing space after data:', () => {
    const parse = createSseDataParser();
    expect(parse('data:{"a":1}\n')).toEqual(['{"a":1}']);
  });
});

describe('parseChatCompletionChunk', () => {
  it('parses content deltas', () => {
    expect(parseChatCompletionChunk('{"choices":[{"delta":{"content":"你好"}}]}')).toEqual({
      done: false,
      text: '你好',
      reasoning: undefined,
      finishReason: undefined,
    });
  });

  it('parses reasoning_content deltas', () => {
    expect(parseChatCompletionChunk('{"choices":[{"delta":{"reasoning_content":"思考中"}}]}')).toEqual({
      done: false,
      text: undefined,
      reasoning: '思考中',
      finishReason: undefined,
    });
  });

  it('parses finish_reason and non-stream message shape', () => {
    expect(parseChatCompletionChunk('{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}')).toEqual({
      done: false,
      text: 'done',
      reasoning: undefined,
      finishReason: 'stop',
    });
  });

  it('recognizes [DONE]', () => {
    expect(parseChatCompletionChunk('[DONE]')).toEqual({ done: true });
  });

  it('throws PROTOCOL on mid-stream error objects', () => {
    expect(() => parseChatCompletionChunk('{"error":{"message":"bad key"}}')).toThrowError(OpenAiChatError);
    expect(() => parseChatCompletionChunk('{"error":{"message":"bad key"}}')).toThrowError(/bad key/);
  });

  it('throws PROTOCOL on invalid JSON', () => {
    expect(() => parseChatCompletionChunk('not json')).toThrowError(OpenAiChatError);
  });
});

describe('parseChatCompletionResponse', () => {
  it('parses non-streaming JSON bodies', () => {
    expect(
      parseChatCompletionResponse(
        '{"choices":[{"message":{"content":"hello","reasoning_content":"why"},"finish_reason":"stop"}]}',
      ),
    ).toEqual({
      content: 'hello',
      reasoning: 'why',
      finishReason: 'stop',
    });
  });
});

describe('streamOpenAiChat', () => {
  it('accumulates streamed deltas and invokes onEvent', async () => {
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
      events.push(event.text ?? `<r:${event.reasoning}>`);
    });
    expect(result).toEqual({ content: '你好', reasoning: 'r1', finishReason: 'stop' });
    expect(events).toEqual(['你', '好', '<r:r1>']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'deepseek-chat', stream: true });
  });

  it('returns single JSON result in non-stream mode', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('{"choices":[{"message":{"content":"答案"},"finish_reason":"stop"}]}', { status: 200 }),
    );
    const result = await streamOpenAiChat(
      baseOptions(fetchImpl as unknown as typeof fetch, { stream: false }),
      () => undefined,
    );
    expect(result).toEqual({ content: '答案', reasoning: undefined, finishReason: 'stop' });
  });

  it('maps 401 to AUTH error with server detail', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"error":{"message":"invalid key"}}', { status: 401 }));
    await expect(
      streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch), () => undefined),
    ).rejects.toMatchObject({ code: 'AUTH', status: 401 });
  });

  it('maps 429 to RATE_LIMIT error', async () => {
    const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
    await expect(
      streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch), () => undefined),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('rejects with ABORTED when the user signal fires before connect', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    await expect(
      streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch, { signal: controller.signal }), () => undefined),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('rejects with PROTOCOL when the stream contains an error object', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse(['data: {"error":{"message":"insufficient balance"}}\n\n']),
    );
    await expect(
      streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch), () => undefined),
    ).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('rejects with TIMEOUT on total timeout', async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>(() => undefined), // never resolves
    );
    await expect(
      streamOpenAiChat(baseOptions(fetchImpl as unknown as typeof fetch, { totalTimeoutMs: 30 }), () => undefined),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
