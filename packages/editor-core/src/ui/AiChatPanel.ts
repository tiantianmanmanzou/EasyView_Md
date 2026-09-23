/**
 * AI Chat Panel — right-side chat panel for conversing with an LLM and, in
 * agent mode, applying exact structured patches to the current markdown file.
 */

import type {
  AiChatAttachment,
  AiChatHistoryEntry,
  AiChatSettings,
  EditorToHostMessage,
  HostToEditorMessage,
} from '@easyview/contracts';
import { applyAiTextPatches, DEFAULT_AI_CHAT_SETTINGS } from '@easyview/contracts';
import { decorateRenderedMarkdown, renderAssistantMarkdown } from './aiChatMarkdown';

const PANEL_WIDTH_STORAGE_KEY = 'easyview-ai-chat-width';
const MODEL_STORAGE_KEY = 'easyview-ai-chat-model';
const HISTORY_KEY_PREFIX = 'easyview-ai-chat-history:';
const PANEL_MIN_WIDTH = 280;
const PANEL_MAX_WIDTH = 560;
const PANEL_DEFAULT_WIDTH = 360;
const MAX_STORED_MESSAGES = 200;
const MAX_STORED_MESSAGE_CHARS = 32_000;

type ChatMode = 'chat' | 'agent';

type MessageBadge = 'applied' | 'no-change' | 'no-doc' | 'stopped' | 'error';

interface ChatUiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolActivities?: string[];
  attachments?: AiChatAttachment[];
  badge?: MessageBadge;
  error?: string;
  streaming?: boolean;
}

interface StoredAiChatSession {
  version: 1;
  mode: ChatMode;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    reasoning?: string;
    badge?: MessageBadge;
    error?: string;
  }>;
}

export interface AiChatPanelDeps {
  postMessage: (message: EditorToHostMessage) => void;
  getDocumentContent: () => string;
  getFilePath: () => string;
  getFileName: () => string;
  applyDocumentEdit: (content: string) => void;
  copyText: (text: string, successMessage?: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
  container?: HTMLElement | null;
}

export interface AiChatPanel {
  toggle: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  setFilePath: (filePath: string) => void;
  setDocumentContextAvailable: (available: boolean) => void;
  handleMessage: (message: HostToEditorMessage) => boolean;
  destroy: () => void;
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ensureAiChatPanelStyles(): void {
  const styleId = 'easyview-ai-chat-panel-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .ai-chat-panel {
      display: flex;
      flex-direction: column;
      width: 360px;
      min-width: 280px;
      max-width: 560px;
      flex-shrink: 0;
      position: relative;
      overflow: hidden;
      border-left: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      background: var(--vscode-editor-background, #1e1e1e);
      transition: margin-right 0.2s ease, opacity 0.2s ease, width 0.2s ease, min-width 0.2s ease, border-color 0.2s ease;
    }
    .ai-chat-panel.hidden {
      margin-right: calc(-1 * var(--easyview-ai-chat-width, 360px));
      opacity: 0;
      pointer-events: none;
    }
    /* Desktop docks the panel in #desktop-ai-chat-host; collapse host width fully. */
    .ai-chat-panel.ai-chat-panel-docked.hidden {
      width: 0 !important;
      min-width: 0 !important;
      margin-right: 0;
      border-left-color: transparent;
      opacity: 0;
      pointer-events: none;
    }
    .ai-chat-panel.resizing {
      transition: none;
    }
    .ai-chat-resizer {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 5px;
      cursor: col-resize;
      z-index: 10;
    }
    .ai-chat-resizer:hover, .ai-chat-panel.resizing .ai-chat-resizer {
      background: var(--mdpre-accent, #4080d0);
      opacity: 0.5;
    }
    .ai-chat-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      flex-shrink: 0;
    }
    .ai-chat-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #e5e7eb);
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-mode-switch {
      display: inline-flex;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      border-radius: 6px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .ai-chat-mode-btn {
      padding: 3px 10px;
      font-size: 11px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      font-family: inherit;
    }
    .ai-chat-mode-btn.active {
      background: var(--mdpre-accent, #4080d0);
      color: #fff;
    }
    .ai-chat-mode-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .ai-chat-icon-btn {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 6px;
      color: var(--vscode-icon-foreground, #c5c5c5);
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
    }
    .ai-chat-icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
    }
    .ai-chat-messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .ai-chat-empty {
      margin: auto;
      text-align: center;
      color: var(--vscode-descriptionForeground, #888);
      font-size: 12px;
      line-height: 1.8;
      padding: 20px;
    }
    .ai-chat-msg {
      max-width: 92%;
      font-size: 12px;
      line-height: 1.65;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ai-chat-msg.user {
      align-self: flex-end;
      align-items: flex-end;
    }
    .ai-chat-msg.assistant {
      align-self: flex-start;
      align-items: flex-start;
      width: 92%;
    }
    .ai-chat-bubble {
      padding: 8px 10px;
      border-radius: 10px;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .ai-chat-msg.user .ai-chat-bubble {
      background: color-mix(in srgb, var(--mdpre-accent, #4080d0) 22%, transparent);
      color: var(--vscode-editor-foreground, #e5e7eb);
      white-space: pre-wrap;
    }
    .ai-chat-msg.assistant .ai-chat-bubble {
      background: var(--vscode-input-background, rgba(128, 128, 128, 0.08));
      color: var(--vscode-editor-foreground, #e5e7eb);
    }
    .ai-chat-bubble.streaming-text {
      white-space: pre-wrap;
    }
    .ai-chat-msg-attachments {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .ai-chat-msg-attachments img {
      max-width: 120px;
      max-height: 90px;
      border-radius: 6px;
      border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      object-fit: cover;
    }
    .ai-chat-reasoning {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .ai-chat-reasoning summary {
      cursor: pointer;
      user-select: none;
    }
    .ai-chat-badge {
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 8px;
      align-self: flex-start;
    }
    .ai-chat-badge.applied { background: rgba(74, 222, 128, 0.18); color: #4ade80; }
    .ai-chat-badge.no-change, .ai-chat-badge.no-doc, .ai-chat-badge.stopped { background: rgba(148, 163, 184, 0.18); color: var(--vscode-descriptionForeground, #94a3b8); }
    .ai-chat-badge.error { background: rgba(248, 113, 113, 0.18); color: #f87171; }
    .ai-chat-error-text {
      font-size: 11px;
      color: #f87171;
      white-space: pre-wrap;
    }
    .ai-chat-bubble pre {
      position: relative;
      background: var(--vscode-textCodeBlock-background, rgba(0, 0, 0, 0.25));
      border-radius: 6px;
      padding: 8px;
      overflow-x: auto;
      margin: 6px 0;
    }
    .ai-chat-bubble pre code {
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, monospace);
      font-size: 11px;
    }
    .ai-chat-bubble p { margin: 4px 0; }
    .ai-chat-bubble h1, .ai-chat-bubble h2, .ai-chat-bubble h3 { font-size: 13px; margin: 8px 0 4px; }
    .ai-chat-bubble ul, .ai-chat-bubble ol { padding-left: 18px; margin: 4px 0; }
    .ai-chat-bubble a { color: var(--mdpre-accent, #4080d0); }
    .ai-chat-bubble table { border-collapse: collapse; }
    .ai-chat-bubble th, .ai-chat-bubble td { border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.2)); padding: 2px 6px; }
    .ai-chat-code-copy {
      position: absolute;
      top: 4px;
      right: 4px;
      font-size: 10px;
      padding: 1px 6px;
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
      border-radius: 4px;
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #ccc);
      cursor: pointer;
      opacity: 0;
    }
    .ai-chat-bubble pre:hover .ai-chat-code-copy { opacity: 1; }
    .ai-chat-composer {
      border-top: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      flex-shrink: 0;
    }
    .ai-chat-pending-attachments {
      display: none;
      flex-wrap: wrap;
      gap: 6px;
    }
    .ai-chat-pending-attachments.visible { display: flex; }
    .ai-chat-pending-attachment {
      position: relative;
    }
    .ai-chat-pending-attachment img {
      width: 48px;
      height: 48px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      display: block;
    }
    .ai-chat-pending-remove {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: none;
      background: var(--vscode-editor-foreground, #ccc);
      color: var(--vscode-editor-background, #1e1e1e);
      font-size: 10px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
    }
    .ai-chat-url-row {
      display: none;
      gap: 4px;
    }
    .ai-chat-url-row.visible { display: flex; }
    .ai-chat-url-input {
      flex: 1;
      font-size: 11px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      border-radius: 6px;
      background: var(--vscode-input-background, rgba(128, 128, 128, 0.1));
      color: var(--vscode-input-foreground, #eee);
      font-family: inherit;
      min-width: 0;
    }
    .ai-chat-input {
      width: 100%;
      box-sizing: border-box;
      resize: none;
      min-height: 60px;
      max-height: 160px;
      font-size: 12px;
      line-height: 1.6;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      border-radius: 8px;
      background: var(--vscode-input-background, rgba(128, 128, 128, 0.1));
      color: var(--vscode-input-foreground, #eee);
      font-family: inherit;
    }
    .ai-chat-input:focus {
      outline: 1px solid var(--mdpre-accent, #4080d0);
    }
    .ai-chat-composer-bar {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .ai-chat-model-switcher {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .ai-chat-model-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-descriptionForeground, #888);
      cursor: pointer;
      font-family: inherit;
      max-width: 100%;
      overflow: hidden;
    }
    .ai-chat-model-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
    .ai-chat-model-btn .ai-chat-model-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-model-menu {
      display: none;
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      min-width: 180px;
      background: var(--vscode-menu-background, #252526);
      border: 1px solid var(--vscode-menu-border, rgba(128, 128, 128, 0.3));
      border-radius: 8px;
      padding: 4px;
      z-index: 120;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }
    .ai-chat-model-menu.open { display: block; }
    .ai-chat-model-option {
      display: block;
      width: 100%;
      text-align: left;
      font-size: 11px;
      padding: 5px 8px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-menu-foreground, #ccc);
      cursor: pointer;
      font-family: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-model-option:hover { background: var(--vscode-menu-selectionBackground, rgba(128, 128, 128, 0.2)); }
    .ai-chat-model-option.selected { color: var(--mdpre-accent, #4080d0); font-weight: 600; }
    .ai-chat-model-menu-separator {
      height: 1px;
      margin: 4px 0;
      background: var(--vscode-menu-border, rgba(128, 128, 128, 0.2));
    }
    .ai-chat-attach-btn, .ai-chat-send-btn {
      width: 28px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--vscode-icon-foreground, #c5c5c5);
      cursor: pointer;
      flex-shrink: 0;
    }
    .ai-chat-attach-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
    .ai-chat-send-btn {
      background: var(--mdpre-accent, #4080d0);
      color: #fff;
    }
    .ai-chat-send-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .ai-chat-send-btn.stop {
      background: rgba(248, 113, 113, 0.9);
    }
    .ai-chat-settings-view {
      display: none;
      position: absolute;
      inset: 0;
      z-index: 20;
      flex-direction: column;
      background: var(--vscode-editor-background, #1e1e1e);
      overflow-y: auto;
      padding: 12px;
    }
    .ai-chat-settings-view.open { display: flex; }
    .ai-chat-settings-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
    }
    .ai-chat-settings-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #e5e7eb);
      flex: 1;
    }
    .ai-chat-field {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 10px;
    }
    .ai-chat-field label {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .ai-chat-field input[type="text"], .ai-chat-field input[type="password"], .ai-chat-field input[type="number"], .ai-chat-field textarea, .ai-chat-field select {
      font-size: 12px;
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
      border-radius: 6px;
      background: var(--vscode-input-background, rgba(128, 128, 128, 0.1));
      color: var(--vscode-input-foreground, #eee);
      font-family: inherit;
      width: 100%;
      box-sizing: border-box;
    }
    .ai-chat-field textarea { resize: vertical; min-height: 54px; }
    .ai-chat-field-row {
      display: flex;
      gap: 8px;
    }
    .ai-chat-field-row .ai-chat-field { flex: 1; }
    .ai-chat-checkbox-row {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
      font-size: 12px;
      color: var(--vscode-editor-foreground, #e5e7eb);
    }
    .ai-chat-key-status, .ai-chat-web-search-key-status {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .ai-chat-key-status.saved, .ai-chat-web-search-key-status.saved { color: #4ade80; }
    .ai-chat-settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 6px;
    }
    .ai-chat-settings-save {
      flex: 1;
      padding: 6px;
      font-size: 12px;
      border: none;
      border-radius: 6px;
      background: var(--mdpre-accent, #4080d0);
      color: #fff;
      cursor: pointer;
      font-family: inherit;
    }
    .ai-chat-settings-hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground, #888);
      margin-top: 6px;
      line-height: 1.6;
    }
    .ai-chat-settings-status {
      font-size: 11px;
      min-height: 16px;
      margin-top: 6px;
    }
    .ai-chat-settings-status.ok { color: #4ade80; }
    .ai-chat-settings-status.err { color: #f87171; }
  `;
  document.head.appendChild(style);
}

export function createAiChatPanel(deps: AiChatPanelDeps): AiChatPanel {
  ensureAiChatPanelStyles();

  const root = document.createElement('div');
  root.className = 'ai-chat-panel hidden';
  root.innerHTML = `
    <div class="ai-chat-resizer" title="拖拽调整宽度"></div>
    <div class="ai-chat-header">
      <span class="ai-chat-title">AI 对话</span>
      <div class="ai-chat-mode-switch">
        <button class="ai-chat-mode-btn" data-mode="chat" type="button" title="仅对话，不修改文件">Chat</button>
        <button class="ai-chat-mode-btn" data-mode="agent" type="button" title="AI 可直接修改当前文件">Agent</button>
      </div>
      <button class="ai-chat-icon-btn" data-action="settings" type="button" title="模型设置">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="ai-chat-icon-btn" data-action="clear" type="button" title="清空会话">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
      <button class="ai-chat-icon-btn" data-action="close" type="button" title="关闭">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="ai-chat-messages"></div>
    <div class="ai-chat-composer">
      <div class="ai-chat-pending-attachments"></div>
      <div class="ai-chat-url-row">
        <input class="ai-chat-url-input" type="text" placeholder="输入图片 URL，回车添加" />
        <button class="ai-chat-icon-btn" data-action="url-confirm" type="button" title="添加">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
      <textarea class="ai-chat-input" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
      <div class="ai-chat-composer-bar">
        <div class="ai-chat-model-switcher">
          <button class="ai-chat-model-btn" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-.2 3.42-.94 4.65a4 4 0 0 0-.34 3.68L15 16l1.5.5c1.7.6 2.5 1.7 2.5 3.5v1H5v-1c0-1.8.8-2.9 2.5-3.5L9 16l.28-1.67a4 4 0 0 0-.34-3.68C8.2 9.42 8 7.95 8 6a4 4 0 0 1 4-4Z"/></svg>
            <span class="ai-chat-model-name">--</span>
          </button>
          <div class="ai-chat-model-menu">
            <div class="ai-chat-model-options"></div>
            <div class="ai-chat-model-menu-separator"></div>
            <button class="ai-chat-model-option" data-action="open-settings" type="button">设置…</button>
          </div>
        </div>
        <button class="ai-chat-attach-btn" data-action="attach" type="button" title="上传本地图片">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </button>
        <button class="ai-chat-attach-btn" data-action="url" type="button" title="通过 URL 添加图片">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>
        <button class="ai-chat-send-btn" data-action="send" type="button" title="发送">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
    <div class="ai-chat-settings-view">
      <div class="ai-chat-settings-header">
        <span class="ai-chat-settings-title">AI 模型设置</span>
        <button class="ai-chat-icon-btn" data-action="settings-back" type="button" title="返回">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      <div class="ai-chat-field">
        <label>API Key <span class="ai-chat-key-status"></span></label>
        <input class="ai-chat-settings-key" type="password" placeholder="sk-..." autocomplete="off" />
      </div>
      <div class="ai-chat-field">
        <label>Brave Search API Key <span class="ai-chat-web-search-key-status"></span></label>
        <input class="ai-chat-settings-web-search-key" type="password" placeholder="用于 web_search 工具" autocomplete="off" />
      </div>
      <div class="ai-chat-field">
        <label>Base URL（OpenAI 兼容接口）</label>
        <input class="ai-chat-settings-baseurl" type="text" placeholder="https://api.deepseek.com" />
      </div>
      <div class="ai-chat-field">
        <label>模型列表（每行一个，第一个为默认）</label>
        <textarea class="ai-chat-settings-models" rows="3" placeholder="deepseek-chat&#10;deepseek-reasoner"></textarea>
      </div>
      <div class="ai-chat-field-row">
        <div class="ai-chat-field">
          <label>Temperature (0–2)</label>
          <input class="ai-chat-settings-temperature" type="number" min="0" max="2" step="0.1" />
        </div>
        <div class="ai-chat-field">
          <label>Top P (0–1)</label>
          <input class="ai-chat-settings-topp" type="number" min="0" max="1" step="0.05" />
        </div>
      </div>
      <div class="ai-chat-field">
        <label>Max Tokens</label>
        <input class="ai-chat-settings-maxtokens" type="number" min="1" step="1" />
      </div>
      <div class="ai-chat-field">
        <label>系统提示词（可选）</label>
        <textarea class="ai-chat-settings-sysprompt" rows="3" placeholder="例如：你是一位严谨的技术文档编辑…"></textarea>
      </div>
      <div class="ai-chat-checkbox-row">
        <input class="ai-chat-settings-stream" type="checkbox" id="ai-chat-settings-stream" />
        <label for="ai-chat-settings-stream">流式输出</label>
      </div>
      <div class="ai-chat-settings-actions">
        <button class="ai-chat-settings-save" type="button">保存</button>
      </div>
      <div class="ai-chat-settings-status"></div>
      <div class="ai-chat-settings-hint">模型 API Key 与 Brave Search API Key 均加密存储于系统钥匙串。Brave Key 已保存时，Agent 模式可调用 web_search。</div>
    </div>
  `;

  const panelContainer = deps.container ?? document.getElementById('editor-body');
  panelContainer?.appendChild(root);
  if (deps.container) root.classList.add('ai-chat-panel-docked');

  const messagesEl = root.querySelector('.ai-chat-messages') as HTMLElement;
  const inputEl = root.querySelector('.ai-chat-input') as HTMLTextAreaElement;
  const sendBtn = root.querySelector('.ai-chat-send-btn') as HTMLButtonElement;
  const modelBtn = root.querySelector('.ai-chat-model-btn') as HTMLButtonElement;
  const modelNameEl = root.querySelector('.ai-chat-model-name') as HTMLElement;
  const modelMenu = root.querySelector('.ai-chat-model-menu') as HTMLElement;
  const modelOptionsEl = root.querySelector('.ai-chat-model-options') as HTMLElement;
  const pendingAttachmentsEl = root.querySelector('.ai-chat-pending-attachments') as HTMLElement;
  const urlRow = root.querySelector('.ai-chat-url-row') as HTMLElement;
  const urlInput = root.querySelector('.ai-chat-url-input') as HTMLInputElement;
  const settingsView = root.querySelector('.ai-chat-settings-view') as HTMLElement;
  const keyStatusEl = root.querySelector('.ai-chat-key-status') as HTMLElement;
  const webSearchKeyStatusEl = root.querySelector('.ai-chat-web-search-key-status') as HTMLElement;

  const settingsEls = {
    key: root.querySelector('.ai-chat-settings-key') as HTMLInputElement,
    webSearchKey: root.querySelector('.ai-chat-settings-web-search-key') as HTMLInputElement,
    baseUrl: root.querySelector('.ai-chat-settings-baseurl') as HTMLInputElement,
    models: root.querySelector('.ai-chat-settings-models') as HTMLTextAreaElement,
    temperature: root.querySelector('.ai-chat-settings-temperature') as HTMLInputElement,
    topP: root.querySelector('.ai-chat-settings-topp') as HTMLInputElement,
    maxTokens: root.querySelector('.ai-chat-settings-maxtokens') as HTMLInputElement,
    systemPrompt: root.querySelector('.ai-chat-settings-sysprompt') as HTMLTextAreaElement,
    stream: root.querySelector('.ai-chat-settings-stream') as HTMLInputElement,
    save: root.querySelector('.ai-chat-settings-save') as HTMLButtonElement,
    status: root.querySelector('.ai-chat-settings-status') as HTMLElement,
  };

  let openState = false;
  let disposed = false;
  let panelWidth = PANEL_DEFAULT_WIDTH;
  let mode: ChatMode = 'chat';
  let documentContextAvailable = true;
  let messages: ChatUiMessage[] = [];
  let history: AiChatHistoryEntry[] = [];
  let pendingAttachments: AiChatAttachment[] = [];
  let settings: AiChatSettings = { ...DEFAULT_AI_CHAT_SETTINGS };
  let hasApiKey = false;
  let hasWebSearchApiKey = false;
  let selectedModel = '';
  let settingsLoaded = false;
  let activeRequestId: string | null = null;
  let streamingMessageId: string | null = null;
  let currentFilePath = '';
  let renderScheduled = false;
  let inputHistoryIndex: number | null = null;
  let inputHistoryDraft = '';

  // ---------------------------------------------------------------- layout

  const applyPanelWidth = (width?: number): void => {
    if (typeof width === 'number') {
      panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, Math.round(width)));
    }
    root.style.setProperty('--easyview-ai-chat-width', `${panelWidth}px`);
    if (openState || !root.classList.contains('ai-chat-panel-docked')) {
      root.style.width = `${panelWidth}px`;
      root.style.minWidth = `${panelWidth}px`;
    }
  };

  const savePanelWidth = (): void => {
    try {
      window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(panelWidth));
    } catch { /* storage unavailable */ }
  };

  const loadPanelWidth = (): void => {
    try {
      const stored = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
      const parsed = stored ? Number(stored) : NaN;
      if (Number.isFinite(parsed)) {
        panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, parsed));
      }
    } catch { /* storage unavailable */ }
  };

  const notifyLayoutChange = (): void => {
    window.dispatchEvent(new CustomEvent('easyview-editor-layout-change'));
  };

  const beginPanelResize = (event: PointerEvent): void => {
    if (!openState) return;
    event.preventDefault();
    event.stopPropagation();
    const resizer = root.querySelector('.ai-chat-resizer') as HTMLElement;
    const startX = event.clientX;
    const startWidth = root.getBoundingClientRect().width;
    root.classList.add('resizing');
    resizer.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent): void => {
      applyPanelWidth(startWidth - (moveEvent.clientX - startX));
      notifyLayoutChange();
    };
    const onUp = (upEvent: PointerEvent): void => {
      root.classList.remove('resizing');
      try {
        resizer.releasePointerCapture(upEvent.pointerId);
      } catch { /* pointer already released */ }
      resizer.removeEventListener('pointermove', onMove);
      resizer.removeEventListener('pointerup', onUp);
      resizer.removeEventListener('pointercancel', onUp);
      savePanelWidth();
      notifyLayoutChange();
    };
    resizer.addEventListener('pointermove', onMove);
    resizer.addEventListener('pointerup', onUp);
    resizer.addEventListener('pointercancel', onUp);
  };

  // -------------------------------------------------------------- history

  const historyStorageKey = (): string => `${HISTORY_KEY_PREFIX}${currentFilePath}`;

  const persistSession = (): void => {
    if (messages.length === 0) {
      try {
        window.localStorage.removeItem(historyStorageKey());
      } catch { /* storage unavailable */ }
      return;
    }
    const stored: StoredAiChatSession = {
      version: 1,
      mode,
      messages: messages
        .slice(-MAX_STORED_MESSAGES)
        .map((message) => ({
          role: message.role,
          content: message.content.slice(0, MAX_STORED_MESSAGE_CHARS),
          reasoning: message.reasoning?.slice(0, MAX_STORED_MESSAGE_CHARS),
          badge: message.badge,
          error: message.error,
        })),
    };
    try {
      window.localStorage.setItem(historyStorageKey(), JSON.stringify(stored));
    } catch { /* quota exceeded — keep in-memory session */ }
  };

  const restoreSession = (): void => {
    messages = [];
    history = [];
    try {
      const raw = window.localStorage.getItem(historyStorageKey());
      if (raw) {
        const parsed = JSON.parse(raw) as StoredAiChatSession;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.messages)) {
          mode = parsed.mode === 'agent' ? 'agent' : 'chat';
          messages = parsed.messages
            .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
            .map((message) => ({ ...message, id: createRequestId() }));
          history = messages
            .filter((message) => !message.error && message.content.length > 0)
            .map((message) => ({ role: message.role, content: message.content }));
        }
      }
    } catch { /* corrupt entry — start fresh */ }
    updateModeButtons();
    renderMessages();
  };

  // --------------------------------------------------------------- render

  const scrollMessagesToBottom = (): void => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const scheduleScroll = (): void => {
    window.requestAnimationFrame(() => scrollMessagesToBottom());
  };

  const badgeText = (badge: MessageBadge): string => {
    switch (badge) {
      case 'applied': return '已应用到文件 ✓（Ctrl+Z 可撤销）';
      case 'no-change': return '文档无变化';
      case 'no-doc': return '回复中未包含可应用的文档';
      case 'stopped': return '已停止';
      case 'error': return '生成失败';
    }
  };

  const renderMessages = (): void => {
    messagesEl.innerHTML = '';
    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-chat-empty';
      empty.textContent = mode === 'agent'
        ? 'Agent 模式：AI 可直接修改当前文件。\n在输入框描述要做的修改，AI 完成后自动应用（可撤销）。'
        : '与 AI 对话。\n点击左下角切换模型，右上角齿轮配置 API。';
      empty.style.whiteSpace = 'pre-wrap';
      messagesEl.appendChild(empty);
      return;
    }
    for (const message of messages) {
      const item = document.createElement('div');
      item.className = `ai-chat-msg ${message.role}`;
      item.dataset.messageId = message.id;

      if (message.attachments && message.attachments.length > 0) {
        const attachments = document.createElement('div');
        attachments.className = 'ai-chat-msg-attachments';
        for (const attachment of message.attachments) {
          const img = document.createElement('img');
          img.src = attachment.url;
          img.alt = attachment.name;
          attachments.appendChild(img);
        }
        item.appendChild(attachments);
      }

      const bubble = document.createElement('div');
      bubble.className = 'ai-chat-bubble';
      if (message.role === 'user') {
        bubble.textContent = message.content;
      } else if (message.streaming) {
        bubble.classList.add('streaming-text');
        bubble.textContent = message.content.length > 0 ? message.content : '…';
      } else {
        bubble.innerHTML = renderAssistantMarkdown(message.content || '（无内容）');
        decorateRenderedMarkdown(bubble, (code) => deps.copyText(code, '代码已复制'));
      }
      item.appendChild(bubble);

      if (message.toolActivities && message.toolActivities.length > 0) {
        const tools = document.createElement('div');
        tools.className = 'ai-chat-tool-activities';
        tools.textContent = message.toolActivities.join('\n');
        tools.style.whiteSpace = 'pre-wrap';
        item.appendChild(tools);
      }

      if (message.reasoning) {
        const details = document.createElement('details');
        details.className = 'ai-chat-reasoning';
        const summary = document.createElement('summary');
        summary.textContent = '思考过程';
        details.appendChild(summary);
        const body = document.createElement('div');
        body.style.whiteSpace = 'pre-wrap';
        body.textContent = message.reasoning;
        details.appendChild(body);
        item.appendChild(details);
      }

      if (message.badge) {
        const badge = document.createElement('span');
        badge.className = `ai-chat-badge ${message.badge}`;
        badge.textContent = badgeText(message.badge);
        item.appendChild(badge);
      }

      if (message.error) {
        const errorText = document.createElement('div');
        errorText.className = 'ai-chat-error-text';
        errorText.textContent = message.error;
        item.appendChild(errorText);
      }

      messagesEl.appendChild(item);
    }
    scheduleScroll();
  };

  const renderStreamingMessage = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(() => {
      renderScheduled = false;
      if (disposed) return;
      if (streamingMessageId) {
        const item = messagesEl.querySelector(`[data-message-id="${streamingMessageId}"] .ai-chat-bubble`);
        if (item) {
          item.textContent = messages.find((message) => message.id === streamingMessageId)?.content || '…';
          scheduleScroll();
          return;
        }
      }
      renderMessages();
    });
  };

  // ----------------------------------------------------------- model menu

  const updateModelButton = (): void => {
    modelNameEl.textContent = selectedModel || '--';
    modelBtn.title = selectedModel ? `当前模型: ${selectedModel}` : '选择模型';
    for (const option of modelOptionsEl.querySelectorAll('.ai-chat-model-option')) {
      option.classList.toggle('selected', option.textContent === selectedModel);
    }
  };

  const rebuildModelMenu = (): void => {
    modelOptionsEl.innerHTML = '';
    for (const model of settings.models) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'ai-chat-model-option';
      option.textContent = model;
      option.addEventListener('click', () => {
        selectedModel = model;
        try {
          window.localStorage.setItem(MODEL_STORAGE_KEY, model);
        } catch { /* storage unavailable */ }
        updateModelButton();
        closeModelMenu();
      });
      modelOptionsEl.appendChild(option);
    }
    if (!selectedModel || !settings.models.includes(selectedModel)) {
      selectedModel = settings.defaultModel || settings.models[0] || '';
    }
    updateModelButton();
  };

  const closeModelMenu = (): void => {
    modelMenu.classList.remove('open');
  };

  modelBtn.addEventListener('click', () => {
    modelMenu.classList.toggle('open');
  });
  document.addEventListener('click', (event) => {
    if (disposed) return;
    if (!modelMenu.classList.contains('open')) return;
    if (!(event.target as HTMLElement).closest('.ai-chat-model-switcher')) {
      closeModelMenu();
    }
  });

  // ------------------------------------------------------------- settings

  const fillSettingsForm = (): void => {
    settingsEls.baseUrl.value = settings.baseUrl;
    settingsEls.models.value = settings.models.join('\n');
    settingsEls.temperature.value = String(settings.temperature);
    settingsEls.topP.value = String(settings.topP);
    settingsEls.maxTokens.value = String(settings.maxTokens);
    settingsEls.systemPrompt.value = settings.systemPrompt;
    settingsEls.stream.checked = settings.stream;
    settingsEls.key.value = '';
    settingsEls.webSearchKey.value = '';
    keyStatusEl.textContent = hasApiKey ? '（已保存）' : '（未设置）';
    keyStatusEl.classList.toggle('saved', hasApiKey);
    webSearchKeyStatusEl.textContent = hasWebSearchApiKey ? '（已保存）' : '（未设置）';
    webSearchKeyStatusEl.classList.toggle('saved', hasWebSearchApiKey);
  };

  const openSettings = (): void => {
    fillSettingsForm();
    settingsView.classList.add('open');
  };

  const closeSettings = (): void => {
    settingsView.classList.remove('open');
  };

  const setSettingsStatus = (text: string, ok: boolean): void => {
    settingsEls.status.textContent = text;
    settingsEls.status.className = `ai-chat-settings-status ${ok ? 'ok' : 'err'}`;
  };

  const requestSettings = (): void => {
    const requestId = createRequestId();
    settingsRequests.set(requestId, 'get');
    deps.postMessage({ type: 'aiChat.getSettings', requestId });
  };

  const settingsRequests = new Map<string, 'get' | 'save'>();

  settingsEls.save.addEventListener('click', () => {
    const models = settingsEls.models.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const temperature = Number(settingsEls.temperature.value);
    const topP = Number(settingsEls.topP.value);
    const maxTokens = Number(settingsEls.maxTokens.value);

    if (models.length === 0) {
      setSettingsStatus('模型列表不能为空', false);
      return;
    }
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      setSettingsStatus('Temperature 需在 0–2 之间', false);
      return;
    }
    if (!Number.isFinite(topP) || topP < 0 || topP > 1) {
      setSettingsStatus('Top P 需在 0–1 之间', false);
      return;
    }
    if (!Number.isFinite(maxTokens) || maxTokens < 1) {
      setSettingsStatus('Max Tokens 需为正整数', false);
      return;
    }

    const nextSettings: AiChatSettings = {
      baseUrl: settingsEls.baseUrl.value.trim(),
      models,
      defaultModel: models[0],
      temperature,
      topP,
      maxTokens: Math.round(maxTokens),
      systemPrompt: settingsEls.systemPrompt.value,
      stream: settingsEls.stream.checked,
    };

    const requestId = createRequestId();
    settingsRequests.set(requestId, 'save');
    deps.postMessage({ type: 'aiChat.saveSettings', requestId, settings: nextSettings });

    const apiKey = settingsEls.key.value.trim();
    if (apiKey.length > 0) {
      deps.postMessage({ type: 'aiChat.saveApiKey', requestId: `${requestId}-key`, apiKey });
    }
    const webSearchApiKey = settingsEls.webSearchKey.value.trim();
    if (webSearchApiKey.length > 0) {
      deps.postMessage({ type: 'aiChat.saveWebSearchApiKey', requestId: `${requestId}-web-search-key`, apiKey: webSearchApiKey });
    }
    setSettingsStatus('保存中…', true);
  });

  // ------------------------------------------------------------ composer

  const updatePendingAttachments = (): void => {
    pendingAttachmentsEl.innerHTML = '';
    pendingAttachmentsEl.classList.toggle('visible', pendingAttachments.length > 0);
    pendingAttachments.forEach((attachment, index) => {
      const item = document.createElement('div');
      item.className = 'ai-chat-pending-attachment';
      const img = document.createElement('img');
      img.src = attachment.url;
      img.alt = attachment.name;
      item.appendChild(img);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ai-chat-pending-remove';
      remove.textContent = '×';
      remove.title = '移除';
      remove.addEventListener('click', () => {
        pendingAttachments.splice(index, 1);
        updatePendingAttachments();
      });
      item.appendChild(remove);
      pendingAttachmentsEl.appendChild(item);
    });
  };

  const addAttachment = (attachment: AiChatAttachment): void => {
    if (pendingAttachments.length >= 6) return;
    pendingAttachments.push(attachment);
    updatePendingAttachments();
  };

  const addImageUrl = (): void => {
    const url = urlInput.value.trim();
    if (!url) return;
    addAttachment({ source: 'url', name: url, url });
    urlInput.value = '';
    urlRow.classList.remove('visible');
  };

  const updateSendButton = (): void => {
    if (activeRequestId) {
      sendBtn.classList.add('stop');
      sendBtn.title = '停止生成';
      sendBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    } else {
      sendBtn.classList.remove('stop');
      sendBtn.title = '发送';
      sendBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    }
  };

  const autoResizeInput = (): void => {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(160, inputEl.scrollHeight)}px`;
  };

  const finishStreaming = (): void => {
    const message = messages.find((item) => item.id === streamingMessageId);
    if (message) message.streaming = false;
    streamingMessageId = null;
    activeRequestId = null;
    updateSendButton();
  };

  const sendMessage = (): void => {
    if (activeRequestId) return;
    const text = inputEl.value.trim();
    if (text.length === 0 && pendingAttachments.length === 0) return;
    if (!hasApiKey) {
      openSettings();
      setSettingsStatus('请先填写 API Key', false);
      return;
    }

    const userMessage: ChatUiMessage = {
      id: createRequestId(),
      role: 'user',
      content: text,
      attachments: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
    };
    messages.push(userMessage);
    if (text.length > 0) history.push({ role: 'user', content: text });

    const assistantMessage: ChatUiMessage = {
      id: createRequestId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };
    messages.push(assistantMessage);
    streamingMessageId = assistantMessage.id;
    activeRequestId = createRequestId();

    const request: EditorToHostMessage = {
      type: 'aiChat.send',
      requestId: activeRequestId,
      mode,
      model: selectedModel,
      userMessage: text,
      attachments: [...pendingAttachments],
      history: history.slice(0, -1).slice(-40),
      documentContent: mode === 'agent' && documentContextAvailable ? deps.getDocumentContent() : undefined,
      documentFileName: mode === 'agent' && documentContextAvailable ? deps.getFileName() : undefined,
      documentFilePath: mode === 'agent' && documentContextAvailable ? deps.getFilePath() : undefined,
    };
    deps.postMessage(request);

    inputEl.value = '';
    inputHistoryIndex = null;
    inputHistoryDraft = '';
    autoResizeInput();
    pendingAttachments = [];
    updatePendingAttachments();
    updateSendButton();
    renderMessages();
  };

  const stopGeneration = (): void => {
    if (!activeRequestId) return;
    deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
  };

  sendBtn.addEventListener('click', () => {
    if (activeRequestId) stopGeneration();
    else sendMessage();
  });

  const navigateSentMessageHistory = (direction: -1 | 1): boolean => {
    const sentMessages = messages
      .filter((message) => message.role === 'user' && message.content.trim().length > 0)
      .map((message) => message.content);
    if (sentMessages.length === 0) return false;

    if (inputHistoryIndex === null) {
      inputHistoryDraft = inputEl.value;
      inputHistoryIndex = direction === -1 ? sentMessages.length - 1 : null;
    } else {
      inputHistoryIndex += direction;
    }

    if (inputHistoryIndex === null || inputHistoryIndex >= sentMessages.length) {
      inputHistoryIndex = null;
      inputEl.value = inputHistoryDraft;
    } else {
      inputHistoryIndex = Math.max(0, inputHistoryIndex);
      inputEl.value = sentMessages[inputHistoryIndex];
    }
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    autoResizeInput();
    return true;
  };

  inputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendMessage();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowUp' && inputEl.selectionStart === 0 && inputEl.selectionEnd === 0) {
      if (navigateSentMessageHistory(-1)) event.preventDefault();
      return;
    }
    if (event.key === 'ArrowDown' && inputEl.selectionStart === inputEl.value.length && inputEl.selectionEnd === inputEl.value.length) {
      if (navigateSentMessageHistory(1)) event.preventDefault();
    }
  });

  inputEl.addEventListener('input', () => {
    inputHistoryIndex = null;
    autoResizeInput();
  });

  inputEl.addEventListener('paste', (event) => {
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    let handled = false;
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      event.preventDefault();
      handled = true;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        addAttachment({ source: 'upload', name: file.name, url: String(reader.result) });
      });
      reader.readAsDataURL(file);
    }
    if (handled) event.stopPropagation();
  });

  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addImageUrl();
    }
  });

  // ------------------------------------------------------------- actions

  const updateModeButtons = (): void => {
    for (const button of root.querySelectorAll<HTMLButtonElement>('.ai-chat-mode-btn')) {
      const buttonMode = button.dataset.mode;
      button.classList.toggle('active', buttonMode === mode);
      if (buttonMode === 'agent') {
        button.disabled = !documentContextAvailable;
        button.title = documentContextAvailable
          ? 'AI 可直接修改当前文件'
          : '仅 Markdown 标签支持 Agent 模式';
      }
    }
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-action]') as HTMLElement | null;
    if (!button) return;
    const action = button.dataset.action;
    switch (action) {
      case 'close':
        close();
        break;
      case 'clear':
        messages = [];
        history = [];
        persistSession();
        renderMessages();
        break;
      case 'settings':
      case 'open-settings':
        closeModelMenu();
        openSettings();
        break;
      case 'settings-back':
        closeSettings();
        break;
      case 'attach':
        deps.postMessage({ type: 'aiChat.pickImage' });
        break;
      case 'url':
        urlRow.classList.toggle('visible');
        if (urlRow.classList.contains('visible')) urlInput.focus();
        break;
      case 'url-confirm':
        addImageUrl();
        break;
    }
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>('.ai-chat-mode-btn')) {
    button.addEventListener('click', () => {
      const requestedMode = button.dataset.mode === 'agent' ? 'agent' : 'chat';
      if (requestedMode === 'agent' && !documentContextAvailable) return;
      mode = requestedMode;
      updateModeButtons();
      if (messages.length === 0) renderMessages();
    });
  }

  (root.querySelector('.ai-chat-resizer') as HTMLElement | null)?.addEventListener('pointerdown', beginPanelResize);

  // --------------------------------------------------------- host messages

  const applyAgentPatches = (patches: import('@easyview/contracts').AiTextPatch[], messageId: string): void => {
    const message = messages.find((item) => item.id === messageId);
    if (!documentContextAvailable) {
      if (message) message.badge = 'no-doc';
      return;
    }
    try {
      const nextContent = applyAiTextPatches(deps.getDocumentContent(), patches);
      if (nextContent === deps.getDocumentContent()) {
        if (message) message.badge = 'no-change';
        return;
      }
      deps.applyDocumentEdit(nextContent);
      if (message) message.badge = 'applied';
    } catch (error) {
      if (message) {
        message.badge = 'error';
        message.error = error instanceof Error ? error.message : String(error);
      }
    }
  };

  const handleMessage = (message: HostToEditorMessage): boolean => {
    if (disposed || !message?.type.startsWith('aiChat.')) return false;
    switch (message.type) {
      case 'aiChat.delta': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (!target) return true;
        if (message.text) target.content += message.text;
        if (message.reasoning) target.reasoning = (target.reasoning ?? '') + message.reasoning;
        renderStreamingMessage();
        return true;
      }
      case 'aiChat.tool': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (!target) return true;
        const action = message.phase === 'call' ? '调用' : '完成';
        target.toolActivities = [...(target.toolActivities ?? []), `${action}工具：${message.toolName}`];
        renderMessages();
        return true;
      }
      case 'aiChat.applyPatches': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (!target || message.path !== deps.getFilePath()) return true;
        applyAgentPatches(message.patches, target.id);
        renderMessages();
        return true;
      }
      case 'aiChat.done': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (target) {
          target.content = message.content;
          target.reasoning = message.reasoning;
        }
        if (message.finishReason === 'length' && target) {
          target.error = '注意：回复因长度限制被截断。';
        }
        if (target && target.content) {
          history.push({ role: 'assistant', content: target.content });
        }
        finishStreaming();
        renderMessages();
        persistSession();
        return true;
      }
      case 'aiChat.error': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (message.aborted) {
          if (target) {
            target.badge = 'stopped';
            if (target.content) history.push({ role: 'assistant', content: target.content });
          }
        } else if (target) {
          if (target.content) {
            // Partial reply kept; error surfaced alongside.
            history.push({ role: 'assistant', content: target.content });
            target.badge = 'error';
            target.error = message.message;
          } else {
            target.error = message.message;
            target.badge = 'error';
          }
        }
        finishStreaming();
        renderMessages();
        persistSession();
        return true;
      }
      case 'aiChat.settingsResponse': {
        settingsLoaded = true;
        settings = message.settings;
        hasApiKey = message.hasApiKey;
        hasWebSearchApiKey = message.hasWebSearchApiKey;
        rebuildModelMenu();
        if (settingsView.classList.contains('open')) fillSettingsForm();
        return true;
      }
      case 'aiChat.settingsSaved': {
        const kind = settingsRequests.get(message.requestId);
        settingsRequests.delete(message.requestId);
        if (kind === 'save') {
          setSettingsStatus(message.ok ? (message.message ?? '已保存') : (message.message ?? '保存失败'), message.ok);
        }
        requestSettings();
        return true;
      }
      case 'aiChat.imagePicked': {
        for (const image of message.images) {
          addAttachment({ source: 'upload', name: image.name, url: image.dataUrl });
        }
        return true;
      }
      default:
        return false;
    }
  };

  // ------------------------------------------------------- open / destroy

  const setVisible = (visible: boolean): void => {
    if (disposed || openState === visible) return;
    openState = visible;
    root.classList.toggle('hidden', !visible);
    if (visible) {
      applyPanelWidth();
    } else if (root.classList.contains('ai-chat-panel-docked')) {
      root.style.width = '0px';
      root.style.minWidth = '0px';
    }
    deps.onVisibilityChange?.(visible);
    if (visible) {
      if (!settingsLoaded) requestSettings();
      notifyLayoutChange();
      window.setTimeout(() => {
        if (!disposed && openState) inputEl.focus();
      }, 220);
    } else {
      if (activeRequestId) stopGeneration();
      closeModelMenu();
      closeSettings();
      notifyLayoutChange();
    }
  };

  const open = (): void => setVisible(true);
  const close = (): void => setVisible(false);
  const toggle = (): void => setVisible(!openState);

  const setFilePath = (filePath: string): void => {
    if (filePath === currentFilePath) return;
    persistSession();
    currentFilePath = filePath;
    restoreSession();
  };

  const setDocumentContextAvailable = (available: boolean): void => {
    if (documentContextAvailable === available) return;
    documentContextAvailable = available;
    if (!available && mode === 'agent') mode = 'chat';
    updateModeButtons();
    renderMessages();
  };

  const destroy = (): void => {
    if (disposed) return;
    disposed = true;
    if (activeRequestId) {
      deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
    }
    root.remove();
  };

  loadPanelWidth();
  applyPanelWidth();
  setFilePath(deps.getFilePath());
  updateModeButtons();
  updateSendButton();
  updatePendingAttachments();

  return {
    toggle,
    open,
    close,
    isOpen: () => openState,
    setFilePath,
    setDocumentContextAvailable,
    handleMessage,
    destroy,
  };
}
