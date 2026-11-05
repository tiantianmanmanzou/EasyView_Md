/**
 * AI Chat Panel — right-side chat panel for conversing with an LLM and, in
 * agent mode, applying exact structured patches to the current markdown file.
 */

import type {
  AiOfficeCellChange,
  AiOfficeDocxChange,
  AiOfficeDocxComment,
  AiOfficeDocxItemDecision,
  AiOfficeDocxResolution,
  AiChatAttachment,
  AiChatSettings,
  EditorToHostMessage,
  HostToEditorMessage,
} from '@easyview/contracts';
import { applyAiTextPatches, DEFAULT_AI_CHAT_SETTINGS, AI_CHAT_MAX_IMAGE_BYTES, aiChatImagesWithinBudget, aiChatAttachmentBytes } from '@easyview/contracts';
import { decorateRenderedMarkdown, renderAssistantMarkdown, createStreamingMarkdownRenderer } from './aiChatMarkdown';
import { tAiChat } from './aiChat.i18n';
import { escapeHtml } from './escapeHtml';
import { openSettingsDialog, settingsCheckbox, settingsFieldWithHint, type SettingsDialogHandle } from './SettingsDialog';
import { maxPanelWidth, PANEL_WIDTH_SANITY_MAX } from '../runtime/panelWidth';
import { AI_CHAT_ICON_HTML } from './aiChatIcon';

const PANEL_WIDTH_STORAGE_KEY = 'easyview-ai-chat-width';
const MODEL_STORAGE_KEY = 'easyview-ai-chat-model';
const MODE_STORAGE_KEY = 'easyview-ai-chat-mode';
/** @deprecated Migrated once into thread storage; kept for read/migrate only. */
const LEGACY_HISTORY_KEY_PREFIX = 'easyview-ai-chat-history:';
const THREAD_INDEX_KEY = 'easyview-ai-chat-threads';
const THREAD_ACTIVE_KEY = 'easyview-ai-chat-active-thread';
const THREAD_BODY_PREFIX = 'easyview-ai-chat-thread:';
const PANEL_MIN_WIDTH = 280;
const PANEL_DEFAULT_WIDTH = 360;
export const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_TEXT_CHARS = 1_000_000;
const MAX_REPLY_CHARS = 256_000;
const MAX_VISIBLE_MESSAGES = 80;
const MAX_ATTACHMENT_BYTES = AI_CHAT_MAX_IMAGE_BYTES;
const MAX_STORED_MESSAGES = MAX_CHAT_MESSAGES;
const MAX_THREADS = 50;
/** A settings save that gets no host reply within this time is reported as failed. */
export const SETTINGS_SAVE_TIMEOUT_MS = 15_000;
const MAX_STORED_MESSAGE_CHARS = 32_000;

type ChatMode = 'chat' | 'agent';

type MessageBadge = 'applied' | 'no-change' | 'no-doc' | 'stopped' | 'error';

/** Max diff rows rendered inline for one Office proposal. */
export const MAX_OFFICE_DIFF_ROWS = 50;

type OfficeEditStatus = 'pending' | 'applying' | 'applied' | 'rejected' | 'undoing' | 'undone' | 'error';

interface OfficeEditState {
  proposalId: string;
  fileName: string;
  kind: 'xlsx' | 'docx';
  changes: AiOfficeCellChange[];
  total: number;
  structural: string[];
  truncated: boolean;
  docxChanges?: AiOfficeDocxChange[];
  docxComments?: AiOfficeDocxComment[];
  /** Per-revision toggles for docx; true = keep, false = exclude. */
  itemAccepted?: Record<number, boolean>;
  status: OfficeEditStatus;
  commitId?: string;
  error?: string;
}

interface ChatUiMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; done: boolean }>;
  officeEdits?: OfficeEditState[];
  attachments?: AiChatAttachment[];
  badge?: MessageBadge;
  error?: string;
  streaming?: boolean;
}

interface ThreadIndexEntry {
  id: string;
  title: string;
  mode: ChatMode;
  fileLabel?: string;
  updatedAt: number;
}

interface StoredThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  badge?: MessageBadge;
  error?: string;
  toolCalls?: Array<{ name: string; done: boolean }>;
  officeEdits?: OfficeEditState[];
}

/** Persisted conversation thread — not bound to a document path. */
interface StoredAiChatThread {
  version: 2;
  mode: ChatMode;
  fileLabel?: string;
  updatedAt: number;
  messages: StoredThreadMessage[];
}

export interface AiChatPanelDeps {
  postMessage: (message: EditorToHostMessage) => void;
  getDocumentContent: () => string;
  getFilePath: () => string;
  getFileName: () => string;
  applyDocumentEdit: (content: string) => void | Promise<void>;
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
  /** Hides a docked panel while its document is in the background, without closing it or stopping a reply. */
  setSuspended: (suspended: boolean) => void;
  handleMessage: (message: HostToEditorMessage) => boolean;
  destroy: () => void;
}

function createRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function fileLabelFromPath(filePath: string): string | undefined {
  if (!filePath) return undefined;
  const cleaned = filePath.replace(/^preview:/i, '');
  const base = cleaned.split(/[\\/]/).pop()?.trim();
  return base || undefined;
}

function threadTitleFromMessages(messages: Array<{ role: string; content: string }>): string {
  const first = messages.find((message) => message.role === 'user' && message.content.trim());
  if (!first) return '';
  return first.content.trim().replace(/\s+/g, ' ').slice(0, 48);
}

function sanitizeOfficeEditForStorage(edit: OfficeEditState): OfficeEditState {
  const terminal =
    edit.status === 'pending' || edit.status === 'applying' || edit.status === 'undoing'
      ? 'rejected'
      : edit.status;
  return {
    ...edit,
    status: terminal,
    commitId: undefined,
  };
}

function ensureAiChatPanelStyles(): void {
  const styleId = 'easyview-ai-chat-panel-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .ai-chat-office-edit { margin: 6px 0; padding: 8px; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3)); border-radius: 6px; font-size: 12px; }
    .ai-chat-office-title { font-weight: 600; margin-bottom: 4px; }
    .ai-chat-office-notes { color: var(--vscode-descriptionForeground, #94a3b8); margin: 4px 0; }
    .ai-chat-office-diff { width: 100%; border-collapse: collapse; margin: 4px 0; }
    .ai-chat-office-diff th, .ai-chat-office-diff td { text-align: left; padding: 2px 6px; border-bottom: 1px solid rgba(128,128,128,0.18); word-break: break-all; }
    .ai-chat-office-diff td.before { color: #dc2626; text-decoration: line-through; }
    .ai-chat-office-diff td.after { color: #16a34a; }
    .ai-chat-office-actions { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
    .ai-chat-office-btn { padding: 2px 10px; border-radius: 4px; border: 1px solid rgba(128,128,128,0.4); background: transparent; color: inherit; cursor: pointer; }
    .ai-chat-office-btn.apply { background: #2563eb; border-color: #2563eb; color: #fff; }
    .ai-chat-office-btn.accept-all { background: #15803d; border-color: #15803d; color: #fff; }
    .ai-chat-office-item-actions { display: flex; gap: 4px; white-space: nowrap; }
    .ai-chat-office-item-actions button { padding: 0 6px; font-size: 11px; border-radius: 3px; border: 1px solid rgba(128,128,128,0.35); background: transparent; color: inherit; cursor: pointer; }
    .ai-chat-office-item-actions button.active-accept { border-color: #16a34a; color: #16a34a; }
    .ai-chat-office-item-actions button.active-reject { border-color: #dc2626; color: #dc2626; }
    .ai-chat-office-row-rejected td { opacity: 0.45; }
    .ai-chat-office-status { color: var(--vscode-descriptionForeground, #94a3b8); }
    .ai-chat-panel {
      display: flex;
      flex-direction: column;
      width: 360px;
      min-width: 280px;
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
    .ai-chat-panel.ai-chat-panel-docked.suspended {
      display: none;
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
    .ai-chat-panel-icon {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      margin-right: auto;
      opacity: 0.85;
      cursor: default;
    }
    .ai-chat-history-panel {
      display: none;
      flex-direction: column;
      position: absolute;
      top: 41px;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 20;
      background: var(--vscode-editor-background, #1e1e1e);
      border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
    }
    .ai-chat-history-panel.open { display: flex; }
    .ai-chat-history-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.2));
      flex-shrink: 0;
    }
    .ai-chat-history-new {
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid rgba(128, 128, 128, 0.35);
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
    }
    .ai-chat-history-new:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
    .ai-chat-history-list {
      flex: 1;
      overflow: auto;
      padding: 6px;
    }
    .ai-chat-history-empty {
      padding: 16px 10px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      text-align: center;
    }
    .ai-chat-history-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      text-align: left;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .ai-chat-history-item:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
    .ai-chat-history-item.active { background: color-mix(in srgb, var(--mdpre-accent, #4080d0) 18%, transparent); }
    .ai-chat-history-item-title {
      font-size: 12px;
      font-weight: 560;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-history-item-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #94a3b8);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-panel-icon .ai-chat-icon {
      display: block;
      width: 16px;
      height: 16px;
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
      align-self: stretch;
      align-items: stretch;
      max-width: none;
      min-width: 0;
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
    .ai-chat-tool-line {
      overflow: hidden;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-tool-line.running::after { content: ' …'; }
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
    .ai-chat-bubble table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
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
      flex: 0 1 auto;
      min-width: 0;
    }
    .ai-chat-mode-picker {
      position: relative;
      flex: none;
      margin-right: auto;
    }
    .ai-chat-model-btn, .ai-chat-mode-current {
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
    .ai-chat-model-btn:hover, .ai-chat-mode-current:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)); }
    .ai-chat-model-btn .ai-chat-model-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ai-chat-model-menu, .ai-chat-mode-menu {
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
    .ai-chat-model-menu.open, .ai-chat-mode-menu.open { display: block; }
    .ai-chat-mode-menu { min-width: 200px; }
    .ai-chat-model-option, .ai-chat-mode-option {
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
    .ai-chat-model-option:hover, .ai-chat-mode-option:hover:not(:disabled) { background: var(--vscode-menu-selectionBackground, rgba(128, 128, 128, 0.2)); }
    .ai-chat-mode-option span { margin-left: 8px; color: var(--vscode-descriptionForeground, #888); font-weight: 400; }
    .ai-chat-mode-option.active { color: var(--mdpre-accent, #4080d0); font-weight: 600; }
    .ai-chat-mode-option:disabled { opacity: 0.45; cursor: default; }
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
  `;
  document.head.appendChild(style);
}

/** Agent unless the user last picked Chat; one choice for every document. */
function readStoredMode(): ChatMode {
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === 'chat' ? 'chat' : 'agent';
  } catch {
    return 'agent';
  }
}

export function createAiChatPanel(deps: AiChatPanelDeps): AiChatPanel {
  ensureAiChatPanelStyles();

  const root = document.createElement('div');
  root.className = 'ai-chat-panel hidden';
  const tHtml = (key: Parameters<typeof tAiChat>[0]): string => escapeHtml(tAiChat(key));
  root.innerHTML = `
    <div class="ai-chat-resizer" title="${tHtml('resize')}"></div>
    <div class="ai-chat-header">
      <span class="ai-chat-panel-icon" role="img" title="${tHtml('title')}" aria-label="${tHtml('title')}">${AI_CHAT_ICON_HTML}</span>
      <button class="ai-chat-icon-btn" data-action="history" type="button" title="${tHtml('history')}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>
      </button>
      <button class="ai-chat-icon-btn" data-action="new-chat" type="button" title="${tHtml('history.new')}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      </button>
      <button class="ai-chat-icon-btn" data-action="settings" type="button" title="${tHtml('settings')}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      </button>
      <button class="ai-chat-icon-btn" data-action="clear" type="button" title="${tHtml('clear')}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g transform="rotate(40 12 12)"><path d="M12 3v8M8.5 11h7l2.5 9H6l2.5-9Z"/><path d="m10 15-1 5m5-5 1 5"/></g></svg>
      </button>
    </div>
    <div class="ai-chat-history-panel" data-history-panel>
      <div class="ai-chat-history-toolbar">
        <button class="ai-chat-history-new" data-action="new-chat" type="button">${tHtml('history.new')}</button>
      </div>
      <div class="ai-chat-history-list" data-history-list></div>
    </div>
    <div class="ai-chat-messages"></div>
    <div class="ai-chat-composer">
      <div class="ai-chat-pending-attachments"></div>
      <div class="ai-chat-url-row">
        <input class="ai-chat-url-input" type="text" placeholder="${tHtml('url.placeholder')}" />
        <button class="ai-chat-icon-btn" data-action="url-confirm" type="button" title="${tHtml('url.confirm')}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
      <textarea class="ai-chat-input" placeholder="${tHtml('input.placeholder')}"></textarea>
      <div class="ai-chat-composer-bar">
        <div class="ai-chat-model-switcher">
          <button class="ai-chat-model-btn" type="button">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-.2 3.42-.94 4.65a4 4 0 0 0-.34 3.68L15 16l1.5.5c1.7.6 2.5 1.7 2.5 3.5v1H5v-1c0-1.8.8-2.9 2.5-3.5L9 16l.28-1.67a4 4 0 0 0-.34-3.68C8.2 9.42 8 7.95 8 6a4 4 0 0 1 4-4Z"/></svg>
            <span class="ai-chat-model-name">--</span>
          </button>
          <div class="ai-chat-model-menu">
            <div class="ai-chat-model-options"></div>
            <div class="ai-chat-model-menu-separator"></div>
            <button class="ai-chat-model-option" data-action="open-settings" type="button">${tHtml('model.settings')}</button>
          </div>
        </div>
        <div class="ai-chat-mode-picker">
          <button class="ai-chat-mode-current" type="button" aria-haspopup="menu">
            <span class="ai-chat-mode-label">Agent</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>
          </button>
          <div class="ai-chat-mode-menu" role="menu">
            <button class="ai-chat-mode-option ai-chat-mode-btn" data-mode="agent" type="button" role="menuitemradio" title="${tHtml('mode.agentTitle')}">Agent<span>${tHtml('mode.agentTitle')}</span></button>
            <button class="ai-chat-mode-option ai-chat-mode-btn" data-mode="chat" type="button" role="menuitemradio" title="${tHtml('mode.chatTitle')}">Chat<span>${tHtml('mode.chatTitle')}</span></button>
          </div>
        </div>
        <button class="ai-chat-attach-btn" data-action="attach" type="button" title="${tHtml('attach.local')}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
        </button>
        <button class="ai-chat-attach-btn" data-action="url" type="button" title="${tHtml('attach.url')}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </button>
        <button class="ai-chat-send-btn" data-action="send" type="button" title="${tHtml('send')}">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  `;

  const panelContainer = deps.container ?? document.getElementById('editor-body');
  panelContainer?.appendChild(root);
  if (deps.container) {
    root.classList.add('ai-chat-panel-docked');
    const grip = document.createElement('span');
    grip.className = 'ai-chat-dock-grip';
    grip.dataset.dockGrip = 'aiChat';
    grip.title = tAiChat('dragToDock');
    grip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
    root.querySelector('.ai-chat-header')?.prepend(grip);
  }

  const messagesEl = root.querySelector('.ai-chat-messages') as HTMLElement;
  const historyPanelEl = root.querySelector('[data-history-panel]') as HTMLElement;
  const historyListEl = root.querySelector('[data-history-list]') as HTMLElement;
  const inputEl = root.querySelector('.ai-chat-input') as HTMLTextAreaElement;
  const sendBtn = root.querySelector('.ai-chat-send-btn') as HTMLButtonElement;
  const modelBtn = root.querySelector('.ai-chat-model-btn') as HTMLButtonElement;
  const modelNameEl = root.querySelector('.ai-chat-model-name') as HTMLElement;
  const modelMenu = root.querySelector('.ai-chat-model-menu') as HTMLElement;
  const modeCurrent = root.querySelector('.ai-chat-mode-current') as HTMLButtonElement;
  const modeLabel = root.querySelector('.ai-chat-mode-label') as HTMLElement;
  const modeMenu = root.querySelector('.ai-chat-mode-menu') as HTMLElement;
  const modelOptionsEl = root.querySelector('.ai-chat-model-options') as HTMLElement;
  const pendingAttachmentsEl = root.querySelector('.ai-chat-pending-attachments') as HTMLElement;
  const urlRow = root.querySelector('.ai-chat-url-row') as HTMLElement;
  const urlInput = root.querySelector('.ai-chat-url-input') as HTMLInputElement;

  let openState = false;
  let disposed = false;
  let panelWidth = PANEL_DEFAULT_WIDTH;
  /** Agent by default; falls back to chat only while no document is available, then returns to the chosen mode. */
  let preferredMode: ChatMode = readStoredMode();
  let mode: ChatMode = preferredMode;
  let documentContextAvailable = true;
  let messages: ChatUiMessage[] = [];
  let pendingAttachments: AiChatAttachment[] = [];
  let settings: AiChatSettings = { ...DEFAULT_AI_CHAT_SETTINGS };
  let hasApiKey = false;
  let hasWebSearchApiKey = false;
  let selectedModel = '';
  let settingsLoaded = false;
  let activeRequestId: string | null = null;
  let streamingMessageId: string | null = null;
  /** Active document path for Agent tools only — does not select the chat thread. */
  let currentFilePath = '';
  let activeThreadId = '';
  let renderScheduled = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let renderFrame: number | undefined;
  let scrollFrame: number | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let suspendedState = false;
  const imageRequests = new Set<string>();
  let visibleMessageCount = MAX_VISIBLE_MESSAGES;
  let inputHistoryIndex: number | null = null;
  let inputHistoryDraft = '';

  // ---------------------------------------------------------------- layout

  const applyPanelWidth = (width?: number, max = PANEL_WIDTH_SANITY_MAX): void => {
    if (typeof width === 'number') {
      panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(max, Math.round(width)));
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
        panelWidth = Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_WIDTH_SANITY_MAX, parsed));
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
    const maxWidth = maxPanelWidth(root, PANEL_MIN_WIDTH);
    // A host docking the panel on the left marks an ancestor with data-dock-side="left".
    const direction = root.closest('[data-dock-side="left"]') ? 1 : -1;
    root.classList.add('resizing');
    resizer.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent): void => {
      applyPanelWidth(startWidth + direction * (moveEvent.clientX - startX), maxWidth);
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

  // -------------------------------------------------------------- history (thread-based; not bound to files)

  const trimMessages = (): void => {
    let chars = messages.reduce((sum, message) => sum + message.content.length + (message.reasoning?.length ?? 0), 0);
    let attachmentBytes = messages.reduce((sum, message) => sum + (message.attachments ?? []).reduce((n, attachment) => n + aiChatAttachmentBytes(attachment), 0), 0);
    while (messages.length > 2 && (messages.length > MAX_CHAT_MESSAGES || chars > MAX_CHAT_TEXT_CHARS || attachmentBytes > MAX_ATTACHMENT_BYTES)) {
      const removed = messages.splice(0, Math.min(2, messages.length - 2));
      for (const message of removed) {
        chars -= message.content.length + (message.reasoning?.length ?? 0);
        attachmentBytes -= (message.attachments ?? []).reduce((sum, attachment) => sum + aiChatAttachmentBytes(attachment), 0);
      }
    }
  };

  const readThreadIndex = (): ThreadIndexEntry[] => {
    try {
      const raw = window.localStorage.getItem(THREAD_INDEX_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as ThreadIndexEntry[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry) => entry && typeof entry.id === 'string' && entry.id);
    } catch {
      return [];
    }
  };

  const writeThreadIndex = (entries: ThreadIndexEntry[]): void => {
    try {
      window.localStorage.setItem(THREAD_INDEX_KEY, JSON.stringify(entries.slice(0, MAX_THREADS)));
    } catch { /* quota */ }
  };

  const setActiveThreadId = (id: string): void => {
    activeThreadId = id;
    try {
      window.localStorage.setItem(THREAD_ACTIVE_KEY, id);
    } catch { /* storage unavailable */ }
  };

  const threadBodyKey = (id: string): string => `${THREAD_BODY_PREFIX}${id}`;

  const deleteThreadBody = (id: string): void => {
    try {
      window.localStorage.removeItem(threadBodyKey(id));
    } catch { /* storage unavailable */ }
  };

  const closeHistoryPanel = (): void => {
    historyPanelEl.classList.remove('open');
  };

  const formatThreadTime = (updatedAt: number): string => {
    if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
    try {
      return new Date(updatedAt).toLocaleString();
    } catch {
      return '';
    }
  };

  const renderHistoryPanel = (): void => {
    const entries = readThreadIndex();
    historyListEl.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-chat-history-empty';
      empty.textContent = tAiChat('history.empty');
      historyListEl.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ai-chat-history-item${entry.id === activeThreadId ? ' active' : ''}`;
      button.dataset.threadId = entry.id;
      const title = document.createElement('div');
      title.className = 'ai-chat-history-item-title';
      title.textContent = entry.title.trim() || tAiChat('history.untitled');
      const meta = document.createElement('div');
      meta.className = 'ai-chat-history-item-meta';
      const parts = [
        entry.mode === 'agent' ? 'Agent' : 'Chat',
        entry.fileLabel,
        formatThreadTime(entry.updatedAt),
      ].filter(Boolean);
      meta.textContent = parts.join(' · ');
      button.append(title, meta);
      button.addEventListener('click', () => {
        switchToThread(entry.id);
        closeHistoryPanel();
      });
      historyListEl.appendChild(button);
    }
  };

  const openHistoryPanel = (): void => {
    closeModelMenu();
    renderHistoryPanel();
    historyPanelEl.classList.add('open');
  };

  const serializeMessages = (): StoredThreadMessage[] =>
    messages.slice(-MAX_STORED_MESSAGES).map((message) => ({
      role: message.role,
      content: message.content.slice(0, MAX_STORED_MESSAGE_CHARS),
      reasoning: message.reasoning?.slice(0, MAX_STORED_MESSAGE_CHARS),
      badge: message.badge,
      error: message.error,
      toolCalls: message.toolCalls?.map((call) => ({ name: call.name, done: call.done })),
      officeEdits: message.officeEdits?.map(sanitizeOfficeEditForStorage),
    }));

  const hydrateMessages = (stored: StoredThreadMessage[]): ChatUiMessage[] =>
    stored
      .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
      .map((message) => ({
        id: createRequestId(),
        role: message.role,
        content: typeof message.content === 'string' ? message.content : '',
        reasoning: typeof message.reasoning === 'string' ? message.reasoning : undefined,
        badge: message.badge,
        error: message.error,
        toolCalls: Array.isArray(message.toolCalls)
          ? message.toolCalls.filter((call) => call && typeof call.name === 'string').map((call) => ({
            name: call.name,
            done: call.done !== false,
          }))
          : undefined,
        officeEdits: Array.isArray(message.officeEdits)
          ? message.officeEdits.map((edit) => sanitizeOfficeEditForStorage({
            ...edit,
            status: edit.status ?? 'rejected',
          }))
          : undefined,
      }));

  const upsertIndexEntry = (entry: ThreadIndexEntry): void => {
    const previous = readThreadIndex();
    const next = [entry, ...previous.filter((item) => item.id !== entry.id)]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_THREADS);
    const kept = new Set(next.map((item) => item.id));
    for (const item of previous) {
      if (!kept.has(item.id)) deleteThreadBody(item.id);
    }
    writeThreadIndex(next);
  };

  const removeIndexEntry = (id: string): void => {
    writeThreadIndex(readThreadIndex().filter((entry) => entry.id !== id));
    deleteThreadBody(id);
  };

  const persistSession = (): void => {
    trimMessages();
    if (!activeThreadId) activeThreadId = createRequestId();
    if (messages.length === 0) {
      removeIndexEntry(activeThreadId);
      try {
        window.localStorage.setItem(THREAD_ACTIVE_KEY, activeThreadId);
      } catch { /* storage unavailable */ }
      return;
    }
    const updatedAt = Date.now();
    const fileLabel = fileLabelFromPath(currentFilePath) ?? fileLabelFromPath(deps.getFilePath());
    const stored: StoredAiChatThread = {
      version: 2,
      mode,
      fileLabel,
      updatedAt,
      messages: serializeMessages(),
    };
    try {
      window.localStorage.setItem(threadBodyKey(activeThreadId), JSON.stringify(stored));
      upsertIndexEntry({
        id: activeThreadId,
        title: threadTitleFromMessages(stored.messages) || tAiChat('history.untitled'),
        mode: stored.mode,
        fileLabel: stored.fileLabel,
        updatedAt,
      });
      window.localStorage.setItem(THREAD_ACTIVE_KEY, activeThreadId);
    } catch { /* quota exceeded — keep in-memory session */ }
  };

  const loadThreadMessages = (id: string): StoredAiChatThread | null => {
    try {
      const raw = window.localStorage.getItem(threadBodyKey(id));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as StoredAiChatThread;
      if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.messages)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const applyThreadToUi = (thread: StoredAiChatThread | null): void => {
    messages = thread ? hydrateMessages(thread.messages) : [];
    visibleMessageCount = MAX_VISIBLE_MESSAGES;
    trimMessages();
    mode = documentContextAvailable ? preferredMode : 'chat';
    updateModeButtons();
    renderMessages();
  };

  const ensureActiveThread = (): void => {
    let id = '';
    try {
      id = window.localStorage.getItem(THREAD_ACTIVE_KEY) ?? '';
    } catch { /* storage unavailable */ }
    if (!id) id = createRequestId();
    setActiveThreadId(id);
  };

  const restoreActiveThread = (): void => {
    ensureActiveThread();
    applyThreadToUi(loadThreadMessages(activeThreadId));
  };

  const switchToThread = (id: string): void => {
    if (id === activeThreadId) return;
    if (activeRequestId) {
      deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
      finishStreaming();
    }
    persistSession();
    setActiveThreadId(id);
    applyThreadToUi(loadThreadMessages(id));
    pendingAttachments = [];
    updatePendingAttachments();
    inputEl.value = '';
    autoResizeInput();
  };

  const startNewThread = (): void => {
    if (activeRequestId) {
      deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
      finishStreaming();
    }
    persistSession();
    setActiveThreadId(createRequestId());
    messages = [];
    visibleMessageCount = MAX_VISIBLE_MESSAGES;
    pendingAttachments = [];
    updatePendingAttachments();
    inputEl.value = '';
    autoResizeInput();
    mode = documentContextAvailable ? preferredMode : 'chat';
    updateModeButtons();
    renderMessages();
    closeHistoryPanel();
  };

  const migrateLegacyFileSessions = (): void => {
    try {
      const legacyKeys: string[] = [];
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i);
        if (key?.startsWith(LEGACY_HISTORY_KEY_PREFIX)) legacyKeys.push(key);
      }
      if (legacyKeys.length === 0) return;
      const existing = readThreadIndex();
      const migrated: ThreadIndexEntry[] = [];
      for (const key of legacyKeys) {
        try {
          const raw = window.localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw) as { version?: number; mode?: ChatMode; messages?: StoredThreadMessage[] };
          if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
            window.localStorage.removeItem(key);
            continue;
          }
          const id = createRequestId();
          const fileLabel = fileLabelFromPath(key.slice(LEGACY_HISTORY_KEY_PREFIX.length));
          const updatedAt = Date.now();
          const modeValue: ChatMode = parsed.mode === 'chat' ? 'chat' : 'agent';
          const body: StoredAiChatThread = {
            version: 2,
            mode: modeValue,
            fileLabel,
            updatedAt,
            messages: parsed.messages.map((message) => ({
              role: message.role,
              content: String(message.content ?? '').slice(0, MAX_STORED_MESSAGE_CHARS),
              reasoning: message.reasoning,
              badge: message.badge,
              error: message.error,
            })),
          };
          window.localStorage.setItem(threadBodyKey(id), JSON.stringify(body));
          migrated.push({
            id,
            title: threadTitleFromMessages(body.messages) || tAiChat('history.untitled'),
            mode: modeValue,
            fileLabel,
            updatedAt,
          });
        } catch { /* skip corrupt */ }
        try {
          window.localStorage.removeItem(key);
        } catch { /* ignore */ }
      }
      if (migrated.length > 0) {
        writeThreadIndex([...migrated, ...existing].slice(0, MAX_THREADS));
        if (!window.localStorage.getItem(THREAD_ACTIVE_KEY)) {
          setActiveThreadId(migrated[0]!.id);
        }
      }
    } catch { /* storage unavailable */ }
  };

  // --------------------------------------------------------------- render

  const scrollMessagesToBottom = (): void => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const scheduleScroll = (): void => {
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = window.requestAnimationFrame(() => { scrollFrame = undefined; if (!disposed && !suspendedState) scrollMessagesToBottom(); });
  };

  const badgeText = (badge: MessageBadge): string => {
    switch (badge) {
      case 'applied': return tAiChat('badge.applied');
      case 'no-change': return tAiChat('badge.noChange');
      case 'no-doc': return tAiChat('badge.noDoc');
      case 'stopped': return tAiChat('badge.stopped');
      case 'error': return tAiChat('badge.error');
    }
  };

  /** One line for all tool calls of a reply, e.g. "list_files ×6 · read_file ×12", in first-call order. */
  const toolCallSummary = (calls: Array<{ name: string }>): string => {
    const counts = new Map<string, number>();
    for (const call of calls) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
    const tools = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(' · ');
    return tAiChat('tool.summary', { count: String(calls.length), tools });
  };

  const rendered = new Map<string, { message: ChatUiMessage; element: HTMLElement }>();
  const formatCell = (value: AiOfficeCellChange['before']): string => (value === null || value === '' ? '∅' : String(value));

  const updateOfficeEdit = (messageId: string, proposalId: string, patch: Partial<OfficeEditState>): void => {
    const target = messages.find((item) => item.id === messageId);
    if (!target?.officeEdits) return;
    target.officeEdits = target.officeEdits.map((edit) => (edit.proposalId === proposalId ? { ...edit, ...patch } : edit));
    renderMessages();
  };

  const findOfficeEdit = (predicate: (edit: OfficeEditState) => boolean): { message: ChatUiMessage; edit: OfficeEditState } | null => {
    for (const message of messages) {
      const edit = message.officeEdits?.find(predicate);
      if (edit) return { message, edit };
    }
    return null;
  };

  const renderOfficeEdit = (edit: OfficeEditState, messageId: string): HTMLElement => {
    const box = document.createElement('div');
    box.className = `ai-chat-office-edit ${edit.status}`;
    box.dataset.proposalId = edit.proposalId;
    const isDocx = edit.kind === 'docx';
    const docxChanges = edit.docxChanges ?? [];
    const docxComments = edit.docxComments ?? [];
    const itemAccepted = edit.itemAccepted ?? Object.fromEntries(docxChanges.map((change) => [change.index, true]));
    const title = document.createElement('div');
    title.className = 'ai-chat-office-title';
    title.textContent = isDocx
      ? tAiChat('office.titleDocx', {
          name: edit.fileName,
          changes: edit.total,
          comments: docxComments.length,
        })
      : tAiChat('office.title', { name: edit.fileName, count: edit.total });
    box.appendChild(title);
    if (edit.structural.length > 0) {
      const notes = document.createElement('div');
      notes.className = 'ai-chat-office-notes';
      notes.textContent = edit.structural.join('；');
      box.appendChild(notes);
    }

    if (isDocx && docxChanges.length > 0) {
      const table = document.createElement('table');
      table.className = 'ai-chat-office-diff';
      const head = table.createTHead().insertRow();
      for (const label of [
        tAiChat('office.paragraph'),
        tAiChat('office.before'),
        tAiChat('office.after'),
        '',
      ]) {
        const th = document.createElement('th');
        th.textContent = label;
        head.appendChild(th);
      }
      const body = table.createTBody();
      for (const change of docxChanges.slice(0, MAX_OFFICE_DIFF_ROWS)) {
        const accepted = itemAccepted[change.index] !== false;
        const row = body.insertRow();
        if (!accepted) row.className = 'ai-chat-office-row-rejected';
        row.insertCell().textContent = `¶${change.paragraphIndex}`;
        const before = row.insertCell();
        before.className = 'before';
        before.textContent = change.before;
        const after = row.insertCell();
        after.className = 'after';
        after.textContent = change.after;
        const actionCell = row.insertCell();
        if (edit.status === 'pending') {
          const wrap = document.createElement('div');
          wrap.className = 'ai-chat-office-item-actions';
          const acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.textContent = tAiChat('office.itemAccept');
          acceptBtn.className = accepted ? 'active-accept' : '';
          acceptBtn.onclick = () => {
            updateOfficeEdit(messageId, edit.proposalId, {
              itemAccepted: { ...itemAccepted, [change.index]: true },
            });
          };
          const rejectBtn = document.createElement('button');
          rejectBtn.type = 'button';
          rejectBtn.textContent = tAiChat('office.itemReject');
          rejectBtn.className = accepted ? '' : 'active-reject';
          rejectBtn.onclick = () => {
            updateOfficeEdit(messageId, edit.proposalId, {
              itemAccepted: { ...itemAccepted, [change.index]: false },
            });
          };
          wrap.append(acceptBtn, rejectBtn);
          actionCell.appendChild(wrap);
        } else if (!accepted) {
          actionCell.textContent = tAiChat('office.itemRejected');
        }
      }
      box.appendChild(table);
    } else if (edit.changes.length > 0) {
      const table = document.createElement('table');
      table.className = 'ai-chat-office-diff';
      const head = table.createTHead().insertRow();
      for (const label of [tAiChat('office.cell'), tAiChat('office.before'), tAiChat('office.after')]) {
        const th = document.createElement('th'); th.textContent = label; head.appendChild(th);
      }
      const body = table.createTBody();
      for (const change of edit.changes.slice(0, MAX_OFFICE_DIFF_ROWS)) {
        const row = body.insertRow();
        row.insertCell().textContent = `${change.sheet}!${change.ref}`;
        const before = row.insertCell(); before.className = 'before'; before.textContent = formatCell(change.before);
        const after = row.insertCell(); after.className = 'after'; after.textContent = formatCell(change.after);
      }
      box.appendChild(table);
    }

    const shown = Math.min(isDocx ? docxChanges.length : edit.changes.length, MAX_OFFICE_DIFF_ROWS);
    if (edit.total > shown) {
      const more = document.createElement('div');
      more.className = 'ai-chat-office-notes ai-chat-office-more';
      more.textContent = tAiChat('office.more', { total: edit.total, shown });
      box.appendChild(more);
    }
    const actions = document.createElement('div');
    actions.className = 'ai-chat-office-actions';
    const button = (label: string, className: string, onClick: () => void): void => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `ai-chat-office-btn ${className}`;
      element.textContent = label;
      element.onclick = onClick;
      actions.appendChild(element);
    };
    const collectItemDecisions = (): AiOfficeDocxItemDecision[] =>
      docxChanges.map((change) => ({
        index: change.index,
        accept: itemAccepted[change.index] !== false,
      }));
    const decide = (accepted: boolean, resolution?: AiOfficeDocxResolution) => {
      if (!activeRequestId) return;
      const payload: Extract<EditorToHostMessage, { type: 'aiChat.officeDecision' }> = {
        type: 'aiChat.officeDecision',
        requestId: activeRequestId,
        proposalId: edit.proposalId,
        accepted,
      };
      if (accepted && isDocx) {
        payload.resolution = resolution ?? 'tracked';
        payload.itemDecisions = collectItemDecisions();
      }
      deps.postMessage(payload);
      updateOfficeEdit(messageId, edit.proposalId, { status: accepted ? 'applying' : 'rejected' });
    };
    if (edit.status === 'pending') {
      if (isDocx) {
        button(tAiChat('office.applyTracked'), 'apply', () => decide(true, 'tracked'));
        button(tAiChat('office.acceptAll'), 'accept-all', () => {
          const allAccepted = Object.fromEntries(docxChanges.map((change) => [change.index, true]));
          updateOfficeEdit(messageId, edit.proposalId, { itemAccepted: allAccepted });
          // decide after state patch uses collect from current edit; force accept-all with all true
          if (!activeRequestId) return;
          deps.postMessage({
            type: 'aiChat.officeDecision',
            requestId: activeRequestId,
            proposalId: edit.proposalId,
            accepted: true,
            resolution: 'accept-all',
            itemDecisions: docxChanges.map((change) => ({ index: change.index, accept: true })),
          });
          updateOfficeEdit(messageId, edit.proposalId, {
            itemAccepted: allAccepted,
            status: 'applying',
          });
        });
        button(tAiChat('office.reject'), 'reject', () => decide(false));
      } else {
        button(tAiChat('office.apply'), 'apply', () => decide(true));
        button(tAiChat('office.reject'), 'reject', () => decide(false));
      }
    } else if (edit.status === 'applied' && edit.commitId) {
      const commitId = edit.commitId;
      button(tAiChat('office.undo'), 'undo', () => {
        deps.postMessage({ type: 'aiChat.officeUndo', requestId: createRequestId(), commitId });
        updateOfficeEdit(messageId, edit.proposalId, { status: 'undoing' });
      });
    }
    const status = document.createElement('span');
    status.className = 'ai-chat-office-status';
    status.textContent =
      edit.status === 'error' && edit.error
        ? edit.error
        : edit.status === 'pending' && isDocx
          ? tAiChat('office.status.pendingDocx')
          : tAiChat(`office.status.${edit.status}`);
    actions.appendChild(status);
    box.appendChild(actions);
    return box;
  };

  const renderMessages = (): void => {
    if (disposed || suspendedState) return;
    trimMessages();
    const visible = messages.slice(-visibleMessageCount);
    const ids = new Set(visible.map(message => message.id));
    for (const [id, entry] of rendered) if (!ids.has(id)) { entry.element.remove(); rendered.delete(id); }
    messagesEl.querySelector('.ai-chat-empty')?.remove();
    messagesEl.querySelector('.ai-chat-earlier')?.remove();
    if (messages.length > visible.length) {
      const earlier = document.createElement('button');
      earlier.className = 'ai-chat-earlier'; earlier.textContent = tAiChat('message.showEarlier');
      earlier.onclick = () => { visibleMessageCount += MAX_VISIBLE_MESSAGES; renderMessages(); };
      messagesEl.prepend(earlier);
    }
    if (messages.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-chat-empty';
      empty.textContent = mode === 'agent'
        ? tAiChat('empty.agent')
        : tAiChat('empty.chat');
      empty.style.whiteSpace = 'pre-wrap';
      messagesEl.appendChild(empty);
      return;
    }
    for (const message of visible) {
      const cached = rendered.get(message.id);
      if (cached && (Object.keys(message) as Array<keyof ChatUiMessage>).every(key => cached.message[key] === message[key])) continue;
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

      if (message.toolCalls && message.toolCalls.length > 0) {
        const tools = document.createElement('div');
        tools.className = 'ai-chat-tool-line';
        tools.classList.toggle('running', message.toolCalls.some((call) => !call.done));
        tools.textContent = toolCallSummary(message.toolCalls);
        tools.title = message.toolCalls.map((call) => call.name).join(' → ');
        item.appendChild(tools);
      }

      for (const edit of message.officeEdits ?? []) item.appendChild(renderOfficeEdit(edit, message.id));

      if (message.reasoning) {
        const details = document.createElement('details');
        details.className = 'ai-chat-reasoning';
        const summary = document.createElement('summary');
        summary.textContent = tAiChat('reasoning');
        details.appendChild(summary);
        const body = document.createElement('div');
        body.style.whiteSpace = 'pre-wrap';
        body.textContent = message.reasoning;
        details.appendChild(body);
        item.appendChild(details);
      }

      const previousBubble = cached?.element.querySelector<HTMLElement>('.ai-chat-bubble');
      const bubble = previousBubble && streamRenderers.has(previousBubble) ? previousBubble : document.createElement('div');
      bubble.className = 'ai-chat-bubble';
      if (message.role === 'user') {
        bubble.textContent = message.content;
      } else if (message.streaming) {
        bubble.classList.add('streaming-markdown');
        renderStreamingBubble(bubble, message.content);
      } else if (streamRenderers.has(bubble)) {
        renderStreamingBubble(bubble, message.content, true);
      } else {
        bubble.innerHTML = renderAssistantMarkdown(message.content || tAiChat('message.empty'));
        decorateRenderedMarkdown(bubble, (code) => deps.copyText(code, tAiChat('code.copiedToast')));
      }
      item.appendChild(bubble);

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

      if (cached) cached.element.replaceWith(item); else messagesEl.appendChild(item);
      rendered.set(message.id, { message: { ...message }, element: item });
    }
    let previous: Element | null = messagesEl.querySelector('.ai-chat-earlier');
    for (const message of visible) {
      const element = rendered.get(message.id)!.element;
      const next = previous ? previous.nextElementSibling : messagesEl.firstElementChild;
      if (element !== next) messagesEl.insertBefore(element, next);
      previous = element;
    }
    scheduleScroll();
  };

  /** Streaming replies render as Markdown on each animation frame (calls are rAF-throttled). */
  const streamRenderers = new WeakMap<HTMLElement, ReturnType<typeof createStreamingMarkdownRenderer>>();
  const renderStreamingBubble = (bubble: HTMLElement, content: string, final = false): void => {
    if (!content) { bubble.textContent = '…'; return; }
    let renderer = streamRenderers.get(bubble);
    if (!renderer) { renderer = createStreamingMarkdownRenderer(); streamRenderers.set(bubble, renderer); }
    renderer.render(bubble, content, node => decorateRenderedMarkdown(node, code => deps.copyText(code, tAiChat('code.copiedToast'))), final, true);
  };

  const renderStreamingMessage = (): void => {
    if (renderScheduled || !openState || suspendedState) return;
    renderScheduled = true;
    renderTimer = setTimeout(() => {
      renderFrame = window.requestAnimationFrame(() => {
        renderScheduled = false;
        if (disposed || suspendedState || !openState) return;
        if (streamingMessageId) {
          const item = messagesEl.querySelector(`[data-message-id="${streamingMessageId}"] .ai-chat-bubble`);
          if (item) {
            renderStreamingBubble(item as HTMLElement, messages.find((message) => message.id === streamingMessageId)?.content ?? '');
            scheduleScroll();
            return;
          }
        }
        renderMessages();
      });
    }, 100);
  };

  // ----------------------------------------------------------- model menu

  const updateModelButton = (): void => {
    modelNameEl.textContent = selectedModel || '--';
    modelBtn.title = selectedModel ? tAiChat('model.current', { model: selectedModel }) : tAiChat('model.select');
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
    modeMenu.classList.remove('open');
  };

  modeCurrent.addEventListener('click', () => {
    modelMenu.classList.remove('open');
    closeHistoryPanel();
    modeMenu.classList.toggle('open');
  });

  modelBtn.addEventListener('click', () => {
    modeMenu.classList.remove('open');
    closeHistoryPanel();
    modelMenu.classList.toggle('open');
  });
  const onDocumentClick = (event: MouseEvent): void => {
    if (disposed) return;
    const target = event.target as HTMLElement;
    if (modelMenu.classList.contains('open') && !target.closest('.ai-chat-model-switcher')) modelMenu.classList.remove('open');
    if (modeMenu.classList.contains('open') && !target.closest('.ai-chat-mode-picker')) modeMenu.classList.remove('open');
    if (historyPanelEl.classList.contains('open') && !target.closest('[data-history-panel]') && !target.closest('[data-action="history"]')) {
      closeHistoryPanel();
    }
  };
  document.addEventListener('click', onDocumentClick);

  // ------------------------------------------------------------- settings

  let settingsDialog: SettingsDialogHandle | null = null;

  const openSettings = (initialError?: string): void => {
    settingsDialog?.close();
    const input = (type: string, value: string, placeholder = '', wide = true): HTMLInputElement => {
      const element = document.createElement('input');
      element.type = type;
      element.className = wide ? 'easyview-settings-input is-wide' : 'easyview-settings-input';
      element.value = value;
      element.placeholder = placeholder;
      element.autocomplete = 'off';
      element.spellcheck = false;
      return element;
    };
    const textarea = (value: string, placeholder: string): HTMLTextAreaElement => {
      const element = document.createElement('textarea');
      element.className = 'easyview-settings-textarea';
      element.rows = 3;
      element.value = value;
      element.placeholder = placeholder;
      element.spellcheck = false;
      return element;
    };
    const numberWithRange = (value: number, min: number, step: number, max?: number): { control: HTMLElement; input: HTMLInputElement } => {
      const element = input('number', String(value), '', false);
      element.min = String(min);
      element.step = String(step);
      if (max !== undefined) element.max = String(max);
      const row = document.createElement('div');
      row.className = 'easyview-settings-inline';
      row.append(element);
      if (max !== undefined) {
        const range = document.createElement('span');
        range.className = 'easyview-settings-hint';
        range.textContent = `${min}–${max}`;
        row.append(range);
      }
      return { control: row, input: element };
    };
    const keyField = (placeholder: string, saved: boolean): { control: HTMLElement; input: HTMLInputElement } => {
      const element = input('password', '', placeholder);
      const control = settingsFieldWithHint(element, saved ? tAiChat('settings.keySaved') : tAiChat('settings.keyUnset'));
      if (saved) control.querySelector('.easyview-settings-hint')?.classList.add('is-ok');
      return { control, input: element };
    };

    const apiKey = keyField('sk-...', hasApiKey);
    const webSearchKey = keyField(tAiChat('settings.webSearchKeyPlaceholder'), hasWebSearchApiKey);
    const baseUrl = input('text', settings.baseUrl, 'https://api.deepseek.com');
    const models = textarea(settings.models.join('\n'), 'deepseek-flash\ndeepseek-v4-pro');
    const temperature = numberWithRange(settings.temperature, 0, 0.1, 2);
    const topP = numberWithRange(settings.topP, 0, 0.05, 1);
    const maxTokens = numberWithRange(settings.maxTokens, 1, 1);
    const systemPrompt = textarea(settings.systemPrompt, tAiChat('settings.systemPromptPlaceholder'));
    let stream = settings.stream;

    const dialog = openSettingsDialog({
      title: tAiChat('settings.title'),
      fields: [
        { label: 'API Key', control: apiKey.control, alignTop: true },
        { label: 'Brave Search API Key', control: webSearchKey.control, alignTop: true },
        { label: tAiChat('settings.baseUrl'), control: settingsFieldWithHint(baseUrl, tAiChat('settings.baseUrlHint')), alignTop: true },
        { label: tAiChat('settings.models'), control: settingsFieldWithHint(models, tAiChat('settings.modelsHint')), alignTop: true },
        { label: 'Temperature', control: temperature.control },
        { label: 'Top P', control: topP.control },
        { label: 'Max Tokens', control: maxTokens.control },
        { label: tAiChat('settings.systemPrompt'), control: systemPrompt, alignTop: true },
        { label: tAiChat('settings.output'), control: settingsCheckbox(tAiChat('settings.stream'), stream, (checked) => { stream = checked; }) },
      ],
      note: tAiChat('settings.hint'),
      onSave: () => {
        const modelList = models.value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
        const temperatureValue = Number(temperature.input.value);
        const topPValue = Number(topP.input.value);
        const maxTokensValue = Number(maxTokens.input.value);
        const invalid = modelList.length === 0 ? tAiChat('settings.modelsRequired')
          : !Number.isFinite(temperatureValue) || temperatureValue < 0 || temperatureValue > 2 ? tAiChat('settings.temperatureRange')
            : !Number.isFinite(topPValue) || topPValue < 0 || topPValue > 1 ? tAiChat('settings.topPRange')
              : !Number.isFinite(maxTokensValue) || maxTokensValue < 1 ? tAiChat('settings.maxTokensInvalid')
                : null;
        if (invalid) {
          dialog.setError(invalid);
          return false;
        }
        return saveSettings({
          baseUrl: baseUrl.value.trim(),
          models: modelList,
          defaultModel: modelList[0],
          temperature: temperatureValue,
          topP: topPValue,
          maxTokens: Math.round(maxTokensValue),
          systemPrompt: systemPrompt.value,
          stream,
        }, apiKey.input.value.trim(), webSearchKey.input.value.trim());
      },
      onClose: () => {
        if (settingsDialog === dialog) settingsDialog = null;
      },
    });
    settingsDialog = dialog;
    if (initialError) dialog.setError(initialError);
  };

  const closeSettings = (): void => {
    settingsDialog?.close();
  };

  const requestSettings = (): void => {
    const requestId = createRequestId();
    settingsRequests.set(requestId, 'get');
    deps.postMessage({ type: 'aiChat.getSettings', requestId });
  };

  const settingsRequests = new Map<string, 'get' | 'save'>();
  /** One Save posts up to three requests; it settles when all have answered. */
  let pendingSave: { ids: Set<string>; errors: string[]; timer: ReturnType<typeof setTimeout>; resolve(): void; reject(error: Error): void } | null = null;
  const finishSave = (): void => {
    if (!pendingSave) return;
    clearTimeout(pendingSave.timer);
    const { errors, resolve, reject } = pendingSave; pendingSave = null;
    if (errors.length) reject(new Error(errors.join('\n')));
    else resolve();
  };

  const saveSettings = (nextSettings: AiChatSettings, apiKey: string, webSearchApiKey: string): Promise<void> => {
    if (pendingSave) return Promise.reject(new Error(tAiChat('settings.saveFailed')));
    return new Promise<void>((resolve, reject) => {
      const requestId = createRequestId();
      const ids = new Set<string>([requestId]);
      // Optional keys left empty keep the stored key and send nothing.
      if (apiKey.length > 0) ids.add(`${requestId}-key`);
      if (webSearchApiKey.length > 0) ids.add(`${requestId}-web-search-key`);
      for (const id of ids) settingsRequests.set(id, 'save');
      pendingSave = {
        ids,
        errors: [],
        resolve,
        reject,
        timer: setTimeout(() => {
          if (!pendingSave) return;
          for (const id of pendingSave.ids) settingsRequests.delete(id);
          pendingSave.errors.push(tAiChat('settings.saveTimeout'));
          finishSave();
        }, SETTINGS_SAVE_TIMEOUT_MS),
      };
      try {
        deps.postMessage({ type: 'aiChat.saveSettings', requestId, settings: nextSettings });
        if (apiKey.length > 0) deps.postMessage({ type: 'aiChat.saveApiKey', requestId: `${requestId}-key`, apiKey });
        if (webSearchApiKey.length > 0) deps.postMessage({ type: 'aiChat.saveWebSearchApiKey', requestId: `${requestId}-web-search-key`, apiKey: webSearchApiKey });
      } catch (error) {
        for (const id of ids) settingsRequests.delete(id);
        pendingSave.errors.push(error instanceof Error ? error.message : String(error));
        finishSave();
      }
    });
  };

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
      remove.title = tAiChat('attachment.remove');
      remove.addEventListener('click', () => {
        pendingAttachments.splice(index, 1);
        updatePendingAttachments();
      });
      item.appendChild(remove);
      pendingAttachmentsEl.appendChild(item);
    });
  };

  const addAttachment = (attachment: AiChatAttachment): void => {
    const sizes = [...pendingAttachments, attachment].map(item => aiChatAttachmentBytes(item));
    if (!aiChatImagesWithinBudget(sizes)) {
      messages.push({ id: createRequestId(), role: 'assistant', content: '', error: tAiChat('attachment.tooLarge'), badge: 'error' });
      renderMessages(); return;
    }
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
      sendBtn.title = tAiChat('stop');
      sendBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    } else {
      sendBtn.classList.remove('stop');
      sendBtn.title = tAiChat('send');
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
    if (text.length > MAX_REPLY_CHARS) {
      messages.push({ id: createRequestId(), role: 'assistant', content: '', error: tAiChat('input.tooLarge'), badge: 'error' });
      renderMessages(); return;
    }
    if (text.length === 0 && pendingAttachments.length === 0) return;
    if (!hasApiKey) {
      openSettings(tAiChat('settings.apiKeyRequired'));
      return;
    }

    const userMessage: ChatUiMessage = {
      id: createRequestId(),
      role: 'user',
      content: text,
      attachments: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined,
    };
    messages.push(userMessage);

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
      history: messages.slice(0, -2).filter(message => !message.error && message.content).slice(-40).map(({ role, content }) => ({ role, content })),
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
    const images = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (!aiChatImagesWithinBudget([...pendingAttachments.map(aiChatAttachmentBytes), ...images.map(file => file.size)])) {
      event.preventDefault();
      messages.push({ id: createRequestId(), role: 'assistant', content: '', error: tAiChat('attachment.tooLarge'), badge: 'error' });
      renderMessages(); return;
    }
    let handled = false;
    for (const file of images) {
      if (!file.type.startsWith('image/')) continue;
      event.preventDefault();
      handled = true;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        if (disposed) return;
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
    modeLabel.textContent = mode === 'agent' ? 'Agent' : 'Chat';
    modeCurrent.title = tAiChat(mode === 'agent' ? 'mode.agentTitle' : 'mode.chatTitle');
    for (const button of root.querySelectorAll<HTMLButtonElement>('.ai-chat-mode-btn')) {
      const buttonMode = button.dataset.mode;
      button.classList.toggle('active', buttonMode === mode);
      if (buttonMode === 'agent') {
        button.disabled = !documentContextAvailable;
        button.title = documentContextAvailable
          ? tAiChat('mode.agentTitle')
          : tAiChat('mode.agentUnavailable');
      }
    }
  };

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest('[data-action]') as HTMLElement | null;
    if (!button) return;
    const action = button.dataset.action;
    switch (action) {
      case 'clear':
        if (activeRequestId) {
          deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
          finishStreaming();
        }
        // Discard the current thread instead of keeping it in history.
        messages = [];
        persistSession();
        setActiveThreadId(createRequestId());
        pendingAttachments = [];
        updatePendingAttachments();
        inputEl.value = '';
        autoResizeInput();
        closeHistoryPanel();
        renderMessages();
        break;
      case 'history':
        if (historyPanelEl.classList.contains('open')) closeHistoryPanel();
        else openHistoryPanel();
        break;
      case 'new-chat':
        startNewThread();
        break;
      case 'settings':
      case 'open-settings':
        closeModelMenu();
        closeHistoryPanel();
        openSettings();
        break;
      case 'attach':
        const requestId = createRequestId();
        imageRequests.add(requestId);
        deps.postMessage({ type: 'aiChat.pickImage', requestId });
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
      preferredMode = requestedMode;
      mode = requestedMode;
      try {
        window.localStorage.setItem(MODE_STORAGE_KEY, requestedMode);
      } catch { /* storage unavailable */ }
      modeMenu.classList.remove('open');
      updateModeButtons();
      if (messages.length === 0) renderMessages();
    });
  }

  (root.querySelector('.ai-chat-resizer') as HTMLElement | null)?.addEventListener('pointerdown', beginPanelResize);

  // --------------------------------------------------------- host messages

  const applyAgentPatches = async (patches: import('@easyview/contracts').AiTextPatch[], messageId: string): Promise<void> => {
    const message = messages.find((item) => item.id === messageId);
    if (!documentContextAvailable) throw new Error(tAiChat('badge.noDoc'));
    const nextContent = applyAiTextPatches(deps.getDocumentContent(), patches);
    if (nextContent === deps.getDocumentContent()) {
      if (message) message.badge = 'no-change';
      return;
    }
    await deps.applyDocumentEdit(nextContent);
    if (message) message.badge = 'applied';
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
        if (target.content.length + (target.reasoning?.length ?? 0) > MAX_REPLY_CHARS) {
          deps.postMessage({ type: 'aiChat.abort', requestId: message.requestId });
          target.content = target.content.slice(0, MAX_REPLY_CHARS);
          target.reasoning = target.reasoning?.slice(0, Math.max(0, MAX_REPLY_CHARS - target.content.length));
          target.error = tAiChat('message.tooLarge');
          target.badge = 'stopped';
          finishStreaming(); renderMessages(); persistSession();
          return true;
        }
        renderStreamingMessage();
        return true;
      }
      case 'aiChat.tool': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (!target) return true;
        const calls = target.toolCalls ?? [];
        if (message.phase === 'call') {
          target.toolCalls = [...calls, { name: message.toolName, done: false }];
        } else {
          const pending = calls.findIndex((call) => !call.done && call.name === message.toolName);
          target.toolCalls = calls.map((call, index) => (index === pending ? { ...call, done: true } : call));
        }
        renderMessages();
        return true;
      }
      case 'aiChat.applyPatches': {
        if (message.requestId !== activeRequestId) return false;
        const target = messages.find((item) => item.id === streamingMessageId);
        const acknowledge = (error?: string) => deps.postMessage({ type: 'aiChat.patchesApplied', requestId: message.requestId, operationId: message.operationId, error });
        if (!target || message.path !== deps.getFilePath()) {
          acknowledge(tAiChat('badge.noDoc'));
          return true;
        }
        void applyAgentPatches(message.patches, target.id).then(() => {
          acknowledge();
          renderMessages();
        }, error => {
          const detail = error instanceof Error ? error.message : String(error);
          target.badge = 'error'; target.error = detail;
          acknowledge(detail);
          renderMessages();
        });
        return true;
      }
      case 'aiChat.officeProposal': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (!target) {
          deps.postMessage({ type: 'aiChat.officeDecision', requestId: message.requestId, proposalId: message.proposalId, accepted: false });
          return true;
        }
        const kind = message.kind === 'docx' ? 'docx' : 'xlsx';
        const docxChanges = message.docxChanges ?? [];
        target.officeEdits = [...(target.officeEdits ?? []), {
          proposalId: message.proposalId,
          fileName: message.fileName,
          kind,
          changes: message.changes,
          total: message.total,
          structural: message.structural,
          truncated: message.truncated,
          docxChanges,
          docxComments: message.docxComments ?? [],
          itemAccepted: Object.fromEntries(docxChanges.map((change) => [change.index, true])),
          status: 'pending',
        }];
        renderMessages();
        return true;
      }
      case 'aiChat.officeCommitted': {
        const found = findOfficeEdit((edit) => edit.proposalId === message.commitId);
        if (found) updateOfficeEdit(found.message.id, found.edit.proposalId, { status: 'applied', commitId: message.commitId });
        return true;
      }
      case 'aiChat.officeUndone': {
        const found = findOfficeEdit((edit) => edit.commitId === message.commitId);
        if (found) updateOfficeEdit(found.message.id, found.edit.proposalId, message.error ? { status: 'error', error: message.error } : { status: 'undone' });
        return true;
      }
      case 'aiChat.done': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (target?.officeEdits?.some((edit) => edit.status === 'applying' || edit.status === 'pending')) {
          // A decision that never produced a commit was refused by the host (e.g. the file changed on disk).
          target.officeEdits = target.officeEdits.map((edit) => (edit.status === 'applying' ? { ...edit, status: 'error', error: tAiChat('office.notWritten') } : edit.status === 'pending' ? { ...edit, status: 'rejected' } : edit));
        }
        if (target) {
          target.content = message.content;
          target.reasoning = message.reasoning;
        }
        if (message.finishReason === 'length' && target) {
          target.error = tAiChat('truncated');
        }
        finishStreaming();
        renderMessages();
        persistSession();
        return true;
      }
      case 'aiChat.error': {
        if (message.requestId !== activeRequestId) return true;
        const target = messages.find((item) => item.id === streamingMessageId);
        if (target?.officeEdits?.some((edit) => edit.status === 'pending' || edit.status === 'applying')) {
          target.officeEdits = target.officeEdits.map((edit) => (edit.status === 'pending' || edit.status === 'applying' ? { ...edit, status: 'rejected' } : edit));
        }
        if (message.aborted) {
          if (target) {
            target.badge = 'stopped';
          }
        } else if (target) {
          if (target.content) {
            // Partial reply kept; error surfaced alongside.
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
        if (settingsRequests.get(message.requestId) !== 'get') return false;
        settingsRequests.delete(message.requestId);
        settingsLoaded = true;
        settings = message.settings;
        hasApiKey = message.hasApiKey;
        hasWebSearchApiKey = message.hasWebSearchApiKey;
        rebuildModelMenu();
        return true;
      }
      case 'aiChat.settingsSaved': {
        const kind = settingsRequests.get(message.requestId);
        // Standalone and document panels accept only requests they own.
        if (!kind) return true;
        settingsRequests.delete(message.requestId);
        if (kind === 'save' && pendingSave?.ids.delete(message.requestId)) {
          if (!message.ok) pendingSave.errors.push(message.message ?? tAiChat('settings.saveFailed'));
          if (pendingSave.ids.size === 0) finishSave();
        }
        requestSettings();
        return true;
      }
      case 'aiChat.imagePicked': {
        if (!imageRequests.delete(message.requestId)) return false;
        if (message.error) {
          messages.push({ id: createRequestId(), role: 'assistant', content: '', error: message.error, badge: 'error' });
          renderMessages();
        }
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
      renderMessages();
      if (!settingsLoaded) requestSettings();
      notifyLayoutChange();
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        if (!disposed && openState) inputEl.focus();
      }, 220);
    } else {
      if (activeRequestId) stopGeneration();
      closeModelMenu();
      closeHistoryPanel();
      closeSettings();
      notifyLayoutChange();
    }
  };

  const open = (): void => setVisible(true);
  const close = (): void => setVisible(false);
  const toggle = (): void => setVisible(!openState);

  const setFilePath = (filePath: string): void => {
    if (filePath === currentFilePath) return;
    // Keep the conversation; only the Agent document context changes.
    // Abort an in-flight Agent turn so patches cannot land on the newly focused file.
    if (activeRequestId) {
      deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
      finishStreaming();
      persistSession();
    }
    currentFilePath = filePath;
  };

  const setDocumentContextAvailable = (available: boolean): void => {
    if (documentContextAvailable === available) return;
    documentContextAvailable = available;
    mode = available ? preferredMode : 'chat';
    updateModeButtons();
    renderMessages();
  };

  const setSuspended = (suspended: boolean): void => {
    if (disposed || root.classList.contains('suspended') === suspended) return;
    if (suspended) persistSession();
    suspendedState = suspended;
    root.classList.toggle('suspended', suspended);
    if (!suspended) {
      // Desktop hosts a Markdown panel and a standalone Office panel that share localStorage.
      restoreActiveThread();
      if (openState) renderMessages();
    }
    if (openState) notifyLayoutChange();
  };

  const destroy = (): void => {
    if (disposed) return;
    persistSession();
    disposed = true;
    document.removeEventListener('click', onDocumentClick);
    closeSettings();
    if (focusTimer) clearTimeout(focusTimer);
    if (scrollFrame !== undefined) window.cancelAnimationFrame(scrollFrame);
    if (renderTimer) clearTimeout(renderTimer);
    if (renderFrame !== undefined) window.cancelAnimationFrame(renderFrame);
    if (pendingSave) { clearTimeout(pendingSave.timer); pendingSave.resolve(); pendingSave = null; }
    settingsRequests.clear();
    imageRequests.clear();
    if (activeRequestId) {
      deps.postMessage({ type: 'aiChat.abort', requestId: activeRequestId });
    }
    rendered.clear();
    messages = [];
    pendingAttachments = [];
    root.remove();
  };

  loadPanelWidth();
  applyPanelWidth();
  currentFilePath = deps.getFilePath();
  migrateLegacyFileSessions();
  restoreActiveThread();
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
    setSuspended,
    handleMessage,
    destroy,
  };
}
