/**
 * OpenAI-compatible chat client backed by Vercel AI SDK.
 *
 * Both VS Code and Electron call this service from Node. The public request
 * shape intentionally remains small while the implementation now uses the
 * AI SDK provider abstraction and supports standard tool loops.
 */

import { APICallError, generateText, stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export interface OpenAiChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** Plain text content, or multimodal parts for user messages. */
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
  /** Inactivity timeout between streamed events. Default 60s. */
  inactivityTimeoutMs?: number;
  /** Total request timeout. Default 300s. */
  totalTimeoutMs?: number;
  /** Vercel AI SDK tools available to this model invocation. */
  tools?: ToolSet;
  /** Maximum LLM steps for a request that invokes tools. Default 8. */
  maxToolSteps?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export type OpenAiChatStreamEvent =
  | { type: 'delta'; text?: string; reasoning?: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; input: unknown; output: unknown };

export interface OpenAiChatResult {
  content: string;
  reasoning?: string;
  finishReason?: string;
}

const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;

function toAiSdkMessages(messages: readonly OpenAiChatMessage[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (typeof message.content === 'string') {
      return { role: message.role, content: message.content };
    }

    if (message.role !== 'user') {
      throw new OpenAiChatError('PROTOCOL', '仅用户消息支持多模态内容');
    }

    return {
      role: 'user',
      content: message.content.map((part) => {
        if (part.type === 'text') return { type: 'text', text: part.text ?? '' };
        const url = part.image_url?.url;
        if (!url) throw new OpenAiChatError('PROTOCOL', '图片消息缺少 URL');
        return {
          type: 'file',
          mediaType: imageMediaType(url),
          data: { type: 'url', url: new URL(url) },
        };
      }),
    };
  });
}

function imageMediaType(url: string): string {
  const match = /^data:(image\/[a-z0-9.+-]+);/i.exec(url);
  return match?.[1]?.toLowerCase() ?? 'image/*';
}

function toFinishReason(reason: string): string {
  return reason === 'tool-calls' ? 'tool_calls' : reason;
}

function errorDetail(error: APICallError): string {
  if (typeof error.data === 'object' && error.data !== null) {
    const candidate = (error.data as { error?: { message?: unknown } }).error?.message;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return error.message;
}

function classifyError(error: unknown, aborted: boolean, timedOut: boolean, totalTimeoutMs: number): OpenAiChatError {
  if (timedOut) {
    return new OpenAiChatError('TIMEOUT', `请求超时（总时长超过 ${Math.round(totalTimeoutMs / 1000)}s）`);
  }
  if (aborted || (error instanceof DOMException && error.name === 'AbortError')) {
    return new OpenAiChatError('ABORTED', '已停止生成');
  }
  if (APICallError.isInstance(error)) {
    const detail = errorDetail(error);
    if (error.statusCode === 401 || error.statusCode === 403) {
      return new OpenAiChatError('AUTH', `API Key 无效或无权限 (HTTP ${error.statusCode}): ${detail}`, error.statusCode);
    }
    if (error.statusCode === 429) {
      return new OpenAiChatError('RATE_LIMIT', `请求过于频繁或额度不足 (HTTP 429): ${detail}`, error.statusCode);
    }
    return new OpenAiChatError('HTTP', `请求失败 (HTTP ${error.statusCode}): ${detail}`, error.statusCode);
  }
  if (error instanceof OpenAiChatError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OpenAiChatError('NETWORK', `网络请求失败: ${message}`);
}

function createRequestAbortController(
  signal: AbortSignal | undefined,
  inactivityTimeoutMs: number,
  totalTimeoutMs: number,
): {
  controller: AbortController;
  resetInactivityTimer: () => void;
  cleanup: () => void;
  didTimeOut: () => boolean;
} {
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
  signal?.addEventListener('abort', onUserAbort);
  if (signal?.aborted) controller.abort();

  return {
    controller,
    resetInactivityTimer,
    cleanup: () => {
      clearTimeout(totalTimer);
      if (inactivityTimer) clearTimeout(inactivityTimer);
      signal?.removeEventListener('abort', onUserAbort);
    },
    didTimeOut: () => timedOut,
  };
}

function buildAiSdkRequest(options: OpenAiChatRequestOptions, signal: AbortSignal) {
  const systemMessages = options.messages.filter((message) => message.role === 'system');
  if (systemMessages.length > 1) {
    throw new OpenAiChatError('PROTOCOL', '每次请求最多允许一条系统消息');
  }
  const system = systemMessages[0]?.content;
  if (system !== undefined && typeof system !== 'string') {
    throw new OpenAiChatError('PROTOCOL', '系统消息必须是纯文本');
  }
  const provider = createOpenAICompatible({
    name: 'easyview',
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    apiKey: options.apiKey,
    fetch: options.fetchImpl,
  });
  const tools = options.tools && Object.keys(options.tools).length > 0 ? options.tools : undefined;
  return {
    model: provider.chatModel(options.model),
    ...(system ? { system } : {}),
    messages: toAiSdkMessages(options.messages.filter((message) => message.role !== 'system')),
    temperature: options.temperature,
    topP: options.topP,
    maxOutputTokens: options.maxTokens,
    abortSignal: signal,
    maxRetries: 0,
    ...(tools ? { tools, stopWhen: stepCountIs(options.maxToolSteps ?? 8) } : {}),
  };
}

/**
 * Sends an OpenAI-compatible request through Vercel AI SDK. Streaming emits
 * text, reasoning, and tool events; tool-enabled requests continue until the
 * configured tool-step limit or a normal model completion.
 */
export async function streamOpenAiChat(
  options: OpenAiChatRequestOptions,
  onEvent: (event: OpenAiChatStreamEvent) => void,
): Promise<OpenAiChatResult> {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const request = createRequestAbortController(options.signal, inactivityTimeoutMs, totalTimeoutMs);

  try {
    if (options.signal?.aborted) {
      throw new OpenAiChatError('ABORTED', '已停止生成');
    }
    if (options.stream === false) {
      const result = await generateText(buildAiSdkRequest(options, request.controller.signal));
      return {
        content: result.text,
        reasoning: result.reasoningText,
        finishReason: toFinishReason(result.finishReason),
      };
    }

    const result = streamText(buildAiSdkRequest(options, request.controller.signal));
    let content = '';
    let reasoning = '';
    request.resetInactivityTimer();

    for await (const part of result.fullStream) {
      request.resetInactivityTimer();
      switch (part.type) {
        case 'text-delta':
          content += part.text;
          onEvent({ type: 'delta', text: part.text });
          break;
        case 'reasoning-delta':
          reasoning += part.text;
          onEvent({ type: 'delta', reasoning: part.text });
          break;
        case 'tool-call':
          onEvent({
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
        case 'tool-result':
          onEvent({
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
            output: part.output,
          });
          break;
        case 'error':
          throw part.error;
      }
    }

    return {
      content,
      reasoning: reasoning || undefined,
      finishReason: toFinishReason(await result.finishReason),
    };
  } catch (error) {
    throw classifyError(error, options.signal?.aborted === true, request.didTimeOut(), totalTimeoutMs);
  } finally {
    request.cleanup();
  }
}
