/** Shared AI chat contracts: settings, attachments, and persisted history. */
export const AI_CHAT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const AI_CHAT_MAX_IMAGES = 4;
export function aiChatImagesWithinBudget(sizes: readonly number[]): boolean {
  return sizes.length <= AI_CHAT_MAX_IMAGES && sizes.reduce((sum, size) => sum + size, 0) <= AI_CHAT_MAX_IMAGE_BYTES;
}

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

export function aiChatAttachmentBytes(attachment: AiChatAttachment): number {
  if (attachment.source !== 'upload') return 0;
  const encoded = attachment.url.slice(attachment.url.indexOf(',') + 1);
  return Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
}

export interface AiChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export const DEFAULT_AI_CHAT_SETTINGS: AiChatSettings = {
  baseUrl: 'https://api.deepseek.com',
  models: ['deepseek-flash', 'deepseek-v4-pro'],
  defaultModel: 'deepseek-flash',
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

/** The shipped default before DeepSeek renamed its API models; an untouched copy is upgraded to the current default. */
const LEGACY_DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner'];

function normalizeModels(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_AI_CHAT_SETTINGS.models];
  const models = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (models.length === 0 || models.join('\n') === LEGACY_DEFAULT_MODELS.join('\n')) return [...DEFAULT_AI_CHAT_SETTINGS.models];
  return models;
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

/** One changed cell in an AI Office (xlsx) edit proposal. */
export interface AiOfficeCellChange {
  sheet: string;
  ref: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

/** One Word revision in an AI Office (docx) edit proposal. */
export interface AiOfficeDocxChange {
  index: number;
  paragraphIndex: number;
  search: string;
  replaceWith: string;
  before: string;
  after: string;
}

/** One comment in an AI Office (docx) edit proposal. */
export interface AiOfficeDocxComment {
  paragraphIndex: number;
  text: string;
  search?: string;
}

/** How the user resolves a DOCX proposal when applying. */
export type AiOfficeDocxResolution = 'tracked' | 'accept-all';

/** Per-revision accept/reject chosen by the user (model must not decide). */
export interface AiOfficeDocxItemDecision {
  index: number;
  accept: boolean;
}
