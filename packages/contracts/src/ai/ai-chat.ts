/** Shared AI chat contracts: settings, attachments, and persisted history. */

export interface AiChatSettings {
  baseUrl: string;
  models: string[];
  defaultModel: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  systemPrompt: string;
  stream: boolean;
}

export interface AiChatAttachment {
  /** 'upload' attachments carry a data URL; 'url' attachments carry a remote URL. */
  source: 'upload' | 'url';
  name: string;
  /** data:image/...;base64,... or https://... */
  url: string;
}

export interface AiChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export const DEFAULT_AI_CHAT_SETTINGS: AiChatSettings = {
  baseUrl: 'https://api.deepseek.com',
  models: ['deepseek-chat', 'deepseek-reasoner'],
  defaultModel: 'deepseek-chat',
  temperature: 1.0,
  topP: 1.0,
  maxTokens: 4096,
  systemPrompt: '',
  stream: true,
};

const MAX_TEMPERATURE = 2;
const MAX_TOP_P = 1;

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return DEFAULT_AI_CHAT_SETTINGS.baseUrl;
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return DEFAULT_AI_CHAT_SETTINGS.baseUrl;
    return trimmed;
  } catch {
    return DEFAULT_AI_CHAT_SETTINGS.baseUrl;
  }
}

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_AI_CHAT_SETTINGS.models];
  const models = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return models.length > 0 ? models : [...DEFAULT_AI_CHAT_SETTINGS.models];
}

function normalizeSystemPrompt(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Coerces arbitrary persisted/user input into a valid AiChatSettings object. */
export function normalizeAiChatSettings(value: unknown): AiChatSettings {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<AiChatSettings> & Record<string, unknown>;
  const models = normalizeModels(raw.models);
  const defaultModel =
    typeof raw.defaultModel === 'string' && models.includes(raw.defaultModel)
      ? raw.defaultModel
      : models[0];
  return {
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    models,
    defaultModel,
    temperature: normalizeNumber(raw.temperature, DEFAULT_AI_CHAT_SETTINGS.temperature, 0, MAX_TEMPERATURE),
    topP: normalizeNumber(raw.topP, DEFAULT_AI_CHAT_SETTINGS.topP, 0, MAX_TOP_P),
    maxTokens: Math.max(1, Math.round(normalizeNumber(raw.maxTokens, DEFAULT_AI_CHAT_SETTINGS.maxTokens, 1, Number.MAX_SAFE_INTEGER))),
    systemPrompt: normalizeSystemPrompt(raw.systemPrompt),
    stream: typeof raw.stream === 'boolean' ? raw.stream : DEFAULT_AI_CHAT_SETTINGS.stream,
  };
}
