/**
 * Host-side AI chat controller: settings persistence, secret API key storage,
 * streaming completions, and image attachment picking.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EditorToHostMessage, HostToEditorMessage } from '@easyview/contracts';
import { normalizeAiChatSettings, type AiChatSettings } from '@easyview/contracts';
import { buildAiChatMessages } from './chatPrompt';
import { OpenAiChatError, streamOpenAiChat } from './openai-chat-client';
import { createAiAgentTools } from './agent-tools';

export interface AiChatSecretStore {
  getApiKey(): Promise<string | null>;
  setApiKey(apiKey: string): Promise<void>;
  getWebSearchApiKey(): Promise<string | null>;
  setWebSearchApiKey(apiKey: string): Promise<void>;
}

export interface AiChatToolContext {
  workspaceRootPath: string | null;
}

export interface AiChatImagePicker {
  pickImages(): Promise<Array<{ name: string; dataUrl: string }>>;
}

export interface AiChatHostOptions {
  settingsFilePath: string;
  secretStore: AiChatSecretStore;
  postMessage: (message: HostToEditorMessage) => void;
  pickImages?: AiChatImagePicker;
  getToolContext?: () => Promise<AiChatToolContext> | AiChatToolContext;
  fetchImpl?: typeof fetch;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof OpenAiChatError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export class AiChatHost {
  private settings: AiChatSettings | null = null;
  private settingsLoaded = false;
  private readonly activeRequests = new Map<string, AbortController>();

  constructor(private readonly options: AiChatHostOptions) {}

  handles(message: EditorToHostMessage): boolean {
    return message.type.startsWith('aiChat.');
  }

  async handle(message: EditorToHostMessage): Promise<void> {
    switch (message.type) {
      case 'aiChat.getSettings':
        await this.respondSettings(message.requestId);
        return;
      case 'aiChat.saveSettings':
        await this.saveSettings(message.requestId, message.settings);
        return;
      case 'aiChat.saveApiKey':
        await this.saveApiKey(message.requestId, message.apiKey);
        return;
      case 'aiChat.saveWebSearchApiKey':
        await this.saveWebSearchApiKey(message.requestId, message.apiKey);
        return;
      case 'aiChat.send':
        void this.runSend(message);
        return;
      case 'aiChat.abort':
        this.activeRequests.get(message.requestId)?.abort();
        return;
      case 'aiChat.pickImage':
        await this.pickImages();
        return;
      default:
        return;
    }
  }

  dispose(): void {
    for (const controller of this.activeRequests.values()) {
      controller.abort();
    }
    this.activeRequests.clear();
  }

  private async loadSettings(): Promise<AiChatSettings> {
    if (this.settingsLoaded && this.settings) return this.settings;
    try {
      const raw = await fs.readFile(this.options.settingsFilePath, 'utf8');
      this.settings = normalizeAiChatSettings(JSON.parse(raw));
    } catch {
      this.settings = normalizeAiChatSettings(undefined);
    }
    this.settingsLoaded = true;
    return this.settings;
  }

  private async persistSettings(settings: AiChatSettings): Promise<void> {
    await fs.mkdir(path.dirname(this.options.settingsFilePath), { recursive: true });
    await fs.writeFile(this.options.settingsFilePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    this.settings = settings;
    this.settingsLoaded = true;
  }

  private async respondSettings(requestId: string): Promise<void> {
    const settings = await this.loadSettings();
    const [apiKey, webSearchApiKey] = await Promise.all([
      this.options.secretStore.getApiKey(),
      this.options.secretStore.getWebSearchApiKey(),
    ]);
    this.options.postMessage({
      type: 'aiChat.settingsResponse',
      requestId,
      settings,
      hasApiKey: Boolean(apiKey?.trim()),
      hasWebSearchApiKey: Boolean(webSearchApiKey?.trim()),
    });
  }

  private async saveSettings(requestId: string, value: AiChatSettings): Promise<void> {
    try {
      const settings = normalizeAiChatSettings(value);
      await this.persistSettings(settings);
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: true,
        message: '已保存',
      });
    } catch (error) {
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: false,
        message: toErrorMessage(error),
      });
    }
  }

  private async saveApiKey(requestId: string, apiKey: string): Promise<void> {
    try {
      const trimmed = apiKey.trim();
      if (!trimmed) throw new Error('API Key 不能为空');
      await this.options.secretStore.setApiKey(trimmed);
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: true,
        message: 'API Key 已保存',
      });
    } catch (error) {
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: false,
        message: toErrorMessage(error),
      });
    }
  }

  private async saveWebSearchApiKey(requestId: string, apiKey: string): Promise<void> {
    try {
      const trimmed = apiKey.trim();
      if (!trimmed) throw new Error('Web Search API Key 不能为空');
      await this.options.secretStore.setWebSearchApiKey(trimmed);
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: true,
        message: 'Web Search API Key 已保存',
      });
    } catch (error) {
      this.options.postMessage({
        type: 'aiChat.settingsSaved',
        requestId,
        ok: false,
        message: toErrorMessage(error),
      });
    }
  }

  private async pickImages(): Promise<void> {
    if (!this.options.pickImages) return;
    try {
      const images = await this.options.pickImages.pickImages();
      if (images.length > 0) {
        this.options.postMessage({ type: 'aiChat.imagePicked', images });
      }
    } catch (error) {
      console.warn('[EasyView AI Chat] Image pick failed:', toErrorMessage(error));
    }
  }

  private async runSend(message: Extract<EditorToHostMessage, { type: 'aiChat.send' }>): Promise<void> {
    const { requestId } = message;
    const controller = new AbortController();
    this.activeRequests.set(requestId, controller);
    try {
      const settings = await this.loadSettings();
      const apiKey = await this.options.secretStore.getApiKey();
      if (!apiKey?.trim()) {
        throw new OpenAiChatError('AUTH', '请先配置 API Key');
      }
      const messages = buildAiChatMessages({
        systemPrompt: settings.systemPrompt,
        mode: message.mode,
        history: message.history,
        userMessage: message.userMessage,
        attachments: message.attachments,
        documentContent: message.documentContent,
        documentFileName: message.documentFileName,
      });
      const [toolContext, webSearchApiKey] = await Promise.all([
        this.options.getToolContext?.() ?? { workspaceRootPath: null },
        this.options.secretStore.getWebSearchApiKey(),
      ]);
      const tools = await createAiAgentTools({
        workspaceRootPath: toolContext.workspaceRootPath,
        activeDocument: message.mode === 'agent' && message.documentFilePath && message.documentContent !== undefined
          ? {
            path: message.documentFilePath,
            content: message.documentContent,
            applyPatches: (patches) => {
              this.options.postMessage({ type: 'aiChat.applyPatches', requestId, path: message.documentFilePath!, patches });
            },
          }
          : undefined,
        includeWorkspaceTools: message.mode === 'agent',
        webSearchApiKey,
        fetchImpl: this.options.fetchImpl,
      });
      const result = await streamOpenAiChat(
        {
          baseUrl: settings.baseUrl,
          apiKey: apiKey.trim(),
          model: message.model,
          messages,
          temperature: settings.temperature,
          topP: settings.topP,
          maxTokens: settings.maxTokens,
          stream: settings.stream,
          signal: controller.signal,
          tools,
          fetchImpl: this.options.fetchImpl,
        },
        (event) => {
          if (event.type === 'delta') {
            this.options.postMessage({
              type: 'aiChat.delta',
              requestId,
              text: event.text,
              reasoning: event.reasoning,
            });
            return;
          }
          this.options.postMessage({
            type: 'aiChat.tool',
            requestId,
            phase: event.type === 'tool-call' ? 'call' : 'result',
            toolName: event.toolName,
            input: event.input,
            ...(event.type === 'tool-result' ? { output: event.output } : {}),
          });
        },
      );
      this.options.postMessage({
        type: 'aiChat.done',
        requestId,
        content: result.content,
        reasoning: result.reasoning,
        finishReason: result.finishReason,
      });
    } catch (error) {
      if (error instanceof OpenAiChatError && error.code === 'ABORTED') {
        this.options.postMessage({
          type: 'aiChat.error',
          requestId,
          message: error.message,
          aborted: true,
        });
        return;
      }
      this.options.postMessage({
        type: 'aiChat.error',
        requestId,
        message: toErrorMessage(error),
      });
    } finally {
      this.activeRequests.delete(requestId);
    }
  }
}
