/**
 * OpenAI-compatible chat completions client (used for Deepseek and any
 * OpenAI-compatible endpoint). Runs in Node hosts (VS Code extension /
 * Electron main); SSE is parsed from the fetch response body stream.
 */

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** Plain text content, or multimodal parts for image messages. */
  content: string | Array<OpenAiChatContentPart>;
}

export interface OpenAiChatContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export type OpenAiChatErrorCode =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'PROTOCOL'
  | 'HTTP';

export class OpenAiChatError extends Error {
  constructor(
    public readonly code: OpenAiChatErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenAiChatError';
  }
}

export interface OpenAiChatRequestOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: OpenAiChatMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  /** Inactivity timeout between chunks. Default 60s. */
  inactivityTimeoutMs?: number;
  /** Total request timeout. Default 300s. */
  totalTimeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface OpenAiChatStreamEvent {
  type: 'delta';
  text?: string;
  reasoning?: string;
}

export interface OpenAiChatResult {
  content: string;
  reasoning?: string;
  finishReason?: string;
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

type FetchLike = typeof fetch;

/**
 * Incremental SSE line parser. Feed decoded text chunks; emits complete
 * `data:` payload strings (CRLF/LF tolerant, comment lines skipped).
 */
export function createSseDataParser(): (chunk: string) => string[] {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const lines: string[] = [];
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      buffer = buffer.slice(newlineIndex + 1);
      if (line.startsWith(':')) continue; // comment / keepalive
      if (line.startsWith('data:')) {
        lines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    return lines;
  };
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null };
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }>;
  error?: { message?: string; code?: string | number } | string;
}

/** Parses a non-streaming chat/completions JSON body. */
export function parseChatCompletionResponse(body: string): OpenAiChatResult {
  let parsed: ChatCompletionChunk;
  try {
    parsed = JSON.parse(body) as ChatCompletionChunk;
  } catch {
    throw new OpenAiChatError('PROTOCOL', `无法解析模型返回: ${body.slice(0, 120)}`);
  }
  if (parsed.error) {
    const message =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? '未知模型错误');
    throw new OpenAiChatError('PROTOCOL', message);
  }
  const choice = parsed.choices?.[0];
  const message = choice?.message ?? choice?.delta;
  return {
    content: message?.content ?? '',
    reasoning: message?.reasoning_content ?? undefined,
    finishReason: choice?.finish_reason ?? undefined,
  };
}

/** Parses one SSE `data:` payload (JSON string or `[DONE]`). */
export function parseChatCompletionChunk(
  data: string,
): { done: false; text?: string; reasoning?: string; finishReason?: string } | { done: true } {
  if (data === '[DONE]') return { done: true };
  let parsed: ChatCompletionChunk;
  try {
    parsed = JSON.parse(data) as ChatCompletionChunk;
  } catch {
    throw new OpenAiChatError('PROTOCOL', `无法解析模型返回的数据片段: ${data.slice(0, 120)}`);
  }
  if (parsed.error) {
    const message =
      typeof parsed.error === 'string' ? parsed.error : (parsed.error.message ?? '未知模型错误');
    throw new OpenAiChatError('PROTOCOL', message);
  }
  const choice = parsed.choices?.[0];
  if (!choice) return { done: false };
  const delta = choice.delta ?? choice.message;
  return {
    done: false,
    text: delta?.content ?? undefined,
    reasoning: delta?.reasoning_content ?? undefined,
    finishReason: choice.finish_reason ?? undefined,
  };
}

function httpError(status: number, body: string): OpenAiChatError {
  let detail = body.slice(0, 500);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // keep raw body
  }
  if (status === 401 || status === 403) {
    return new OpenAiChatError('AUTH', `API Key 无效或无权限 (HTTP ${status}): ${detail}`, status);
  }
  if (status === 429) {
    return new OpenAiChatError('RATE_LIMIT', `请求过于频繁或额度不足 (HTTP 429): ${detail}`, status);
  }
  return new OpenAiChatError('HTTP', `请求失败 (HTTP ${status}): ${detail}`, status);
}

function classifyNetworkError(error: unknown, abortedByUser: boolean): OpenAiChatError {
  if (abortedByUser || (error instanceof Error && error.name === 'AbortError')) {
    return new OpenAiChatError('ABORTED', '已停止生成');
  }
  const message = error instanceof Error ? error.message : String(error);
  return new OpenAiChatError('NETWORK', `网络请求失败: ${message}`);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** Races a promise against an abort signal so hangs cannot outlive the abort. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort);
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Sends a chat completion request. Streaming responses invoke `onEvent` per
 * delta; resolves with the full result when finished.
 */
export async function streamOpenAiChat(
  options: OpenAiChatRequestOptions,
  onEvent: (event: OpenAiChatStreamEvent) => void,
): Promise<OpenAiChatResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, totalTimeoutMs);
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, inactivityTimeoutMs);
  };
  const onUserAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onUserAbort);

  const cleanup = () => {
    clearTimeout(totalTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    options.signal?.removeEventListener('abort', onUserAbort);
  };

  const stream = options.stream !== false;
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.topP !== undefined) body.top_p = options.topP;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;

  try {
    let response: Response;
    try {
      resetInactivityTimer();
      response = await raceAbort(
        fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      if (timedOut) {
        throw new OpenAiChatError('TIMEOUT', `请求超时（总时长超过 ${Math.round(totalTimeoutMs / 1000)}s）`);
      }
      throw classifyNetworkError(error, options.signal?.aborted === true);
    }

    if (!response.ok) {
      throw httpError(response.status, await readErrorBody(response));
    }

    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;

    if (!stream) {
      resetInactivityTimer();
      const text = await response.text();
      const parsed = parseChatCompletionResponse(text);
      content = parsed.content;
      reasoning = parsed.reasoning ?? '';
      finishReason = parsed.finishReason;
    } else {
      if (!response.body) {
        throw new OpenAiChatError('PROTOCOL', '响应缺少可读流');
      }
      const parseData = createSseDataParser();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          resetInactivityTimer();
          for (const data of parseData(decoder.decode(value, { stream: true }))) {
            const parsed = parseChatCompletionChunk(data);
            if (parsed.done) {
              await reader.cancel().catch(() => undefined);
              return {
                content,
                reasoning: reasoning || undefined,
                finishReason,
              };
            }
            if (parsed.text) {
              content += parsed.text;
              onEvent({ type: 'delta', text: parsed.text });
            }
            if (parsed.reasoning) {
              reasoning += parsed.reasoning;
              onEvent({ type: 'delta', reasoning: parsed.reasoning });
            }
            if (parsed.finishReason) finishReason = parsed.finishReason;
          }
        }
      } catch (error) {
        if (timedOut) {
          throw new OpenAiChatError(
            'TIMEOUT',
            `响应超时（超过 ${Math.round(inactivityTimeoutMs / 1000)}s 未收到数据）`,
          );
        }
        if (error instanceof OpenAiChatError) throw error;
        throw classifyNetworkError(error, options.signal?.aborted === true);
      }
    }

    return {
      content,
      reasoning: reasoning || undefined,
      finishReason,
    };
  } finally {
    cleanup();
  }
}
