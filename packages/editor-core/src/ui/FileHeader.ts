/**
 * File Header Bar — top bar with file name, TOC/collapse/width/zoom/source/export controls.
 * Extracted from index.ts as a standalone UI component.
 */

import { nextEasyViewThemeMode, type EditorHostCapabilities, type EasyViewThemeMode as ThemeModeName } from '@easyview/contracts';
import { applyEditorAppearance, EditorAppearanceStore, type EditorAppearanceState, type EasyViewAccentTheme } from './EditorAppearance';
export type { EasyViewAccentTheme } from './EditorAppearance';
import type { EditorToHostMessage } from '@easyview/contracts/protocol';
import { createEditorDomContext, type EditorDomContext } from '../runtime/editorDomContext';
import { escapeHtml } from './escapeHtml';
import { tFileHeader } from './fileHeader.i18n';
import { AI_CHAT_ICON_HTML } from './aiChatIcon';

export interface FileHeaderDeps {
  /** Desktop document name already lives in the tab strip. */
  toolbarOnly?: boolean;
  dom?: EditorDomContext;
  appearance?: EditorAppearanceStore;
  postMessage: (msg: EditorToHostMessage) => void;
  getState: () => { isFullWidth: boolean; isTocVisible: boolean; isTableWrap: boolean; currentContent: string };
  setState: (patch: Partial<{ isFullWidth: boolean; isTocVisible: boolean; isTableWrap: boolean }>) => void;
  onSettingsChange: () => void;
  capabilities: EditorHostCapabilities;
}

export type ToolbarShortcutAction =
  | 'openWithEasyView'
  | 'toggleToc'
  | 'toggleFullWidth'
  | 'toggleTableWrap'
  | 'toggleExternalFollow'
  | 'toggleTheme'
  | 'toggleTerminal'
  | 'toggleStickyNote'
  | 'toggleAiChat'
  | 'openSourceMode'
  | 'toggleViewChanges'
  | 'copyOutlinePath'
  | 'copyFullPath'
  | 'stageFile'
  | 'commitFile'
  | 'scrollTop'
  | 'scrollBottom';

export type ToolbarShortcutConfig = Record<ToolbarShortcutAction, string>;

const SHORTCUT_STORAGE_KEY = 'mdpre-toolbar-shortcuts';
const EXTERNAL_FOLLOW_STORAGE_KEY = 'mdpre-external-follow-scroll';
const TOOLBAR_PINNED_STORAGE_KEY = 'easyview.md.toolbarPinned';

const DEFAULT_SHORTCUTS: ToolbarShortcutConfig = {
  openWithEasyView: 'Alt+E',
  toggleToc: 'Alt+W',
  toggleFullWidth: 'Alt+A',
  toggleTableWrap: 'Alt+D',
  toggleExternalFollow: 'Alt+F',
  toggleTheme: 'Alt+R',
  toggleTerminal: 'Alt+T',
  toggleStickyNote: 'Alt+N',
  toggleAiChat: 'Alt+I',
  openSourceMode: 'Alt+Q',
  toggleViewChanges: 'Alt+V',
  copyOutlinePath: 'Alt+Shift+O',
  copyFullPath: 'Alt+Shift+P',
  stageFile: 'Alt+S',
  commitFile: 'Alt+C',
  scrollTop: 'Alt+ArrowUp',
  scrollBottom: 'Alt+ArrowDown',
};

const shortcutActionLabel = (action: ToolbarShortcutAction): string => tFileHeader(`shortcut.${action}`);


const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

function toDisplayShortcut(shortcut: string): string {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return '';
  const parts = normalized.split('+');
  const mapped = parts.map((part) => {
    if (!IS_MAC) return part;
    if (part === 'Alt') return 'Option';
    if (part === 'Meta') return 'Command';
    if (part === 'Ctrl') return 'Control';
    return part;
  });
  return mapped.join('+');
}

function normalizeShortcut(shortcut: string): string {
  const value = shortcut.trim();
  if (!value) return '';
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return '';

  const mods = new Set<string>();
  let key = '';
  for (const partRaw of parts) {
    const part = partRaw.toLowerCase();
    if (part === 'ctrl' || part === 'control') {
      mods.add('Ctrl');
      continue;
    }
    if (part === 'meta' || part === 'cmd' || part === 'command') {
      mods.add('Meta');
      continue;
    }
    if (part === 'alt' || part === 'option') {
      mods.add('Alt');
      continue;
    }
    if (part === 'shift') {
      mods.add('Shift');
      continue;
    }
    key = normalizeKeyLabel(partRaw);
  }

  const orderedMods = ['Ctrl', 'Meta', 'Alt', 'Shift'].filter((mod) => mods.has(mod));
  if (!key) return orderedMods.join('+');
  return [...orderedMods, key].join('+');
}

function normalizeKeyLabel(key: string): string {
  const lower = key.trim().toLowerCase();
  if (!lower) return '';

  const special: Record<string, string> = {
    up: 'ArrowUp',
    arrowup: 'ArrowUp',
    down: 'ArrowDown',
    arrowdown: 'ArrowDown',
    left: 'ArrowLeft',
    arrowleft: 'ArrowLeft',
    right: 'ArrowRight',
    arrowright: 'ArrowRight',
    space: 'Space',
    ' ': 'Space',
    '/': '/',
  };

  if (special[lower]) return special[lower];

  if (/^f\d{1,2}$/i.test(lower)) return lower.toUpperCase();
  if (lower.length === 1) return lower.toUpperCase();

  return key.length ? key[0].toUpperCase() + key.slice(1).toLowerCase() : key;
}

function formatEventToShortcut(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  let key = '';
  const code = event.code || '';
  const codeKeyMap: Record<string, string> = {
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Space: 'Space',
    Tab: 'Tab',
    Enter: 'Enter',
    Escape: 'Escape',
    Delete: 'Delete',
    Backspace: 'Backspace',
  };

  if (code.startsWith('Key') && code.length === 4) {
    key = code.slice(3).toUpperCase();
  } else if (code.startsWith('Digit') && code.length === 6) {
    key = code.slice(5);
  } else if (code.startsWith('Numpad') && code.length > 6) {
    const np = code.slice(6);
    const npMap: Record<string, string> = {
      Divide: '/',
      Multiply: '*',
      Subtract: '-',
      Add: '+',
      Decimal: '.',
      Enter: 'Enter',
    };
    key = npMap[np] ?? (np.length === 1 ? np : `Numpad${np}`);
  } else if (codeKeyMap[code]) {
    key = codeKeyMap[code];
  } else {
    let fallback = event.key;
    if (fallback === ' ') fallback = 'Space';
    if (fallback === 'Esc') fallback = 'Escape';
    if (fallback === 'OS') fallback = 'Meta';
    if (fallback.length === 1) {
      key = fallback.toUpperCase();
    } else if (fallback.startsWith('Arrow')) {
      key = fallback;
    } else {
      key = normalizeKeyLabel(fallback);
    }
  }

  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) {
    return parts.join('+');
  }

  parts.push(key);
  return normalizeShortcut(parts.join('+'));
}

function readStoredShortcuts(): ToolbarShortcutConfig {
  let overrides: Partial<ToolbarShortcutConfig> = {};
  try {
    const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ToolbarShortcutConfig>;
      overrides = parsed ?? {};
    }
  } catch {
    // Storage can be unavailable in restricted contexts.
  }

  const merged: ToolbarShortcutConfig = { ...DEFAULT_SHORTCUTS };
  (Object.keys(DEFAULT_SHORTCUTS) as ToolbarShortcutAction[]).forEach((action) => {
    const value = overrides[action];
    if (typeof value === 'string') {
      merged[action] = normalizeShortcut(value);
    }
  });
  return merged;
}

function readStoredExternalFollowEnabled(): boolean {
  try {
    const raw = localStorage.getItem(EXTERNAL_FOLLOW_STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Storage can be unavailable in restricted contexts.
  }
  return true;
}

function readStoredToolbarPinned(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_PINNED_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeStoredToolbarPinned(pinned: boolean): void {
  try {
    localStorage.setItem(TOOLBAR_PINNED_STORAGE_KEY, String(pinned));
  } catch {
    // Storage can be unavailable in restricted contexts.
  }
}

function ensureFileHeaderCompactStyles(): void {
  const styleId = 'easyview-file-header-compact-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .file-header-bar {
      padding: 2.4px 12px;
      min-height: 0;
    }
    body.easyview-vscode-editor .file-header-bar {
      position: relative !important;
      box-shadow: none !important;
      border-bottom: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, rgba(128, 128, 128, .35)));
      transform-origin: top center;
      transition:
        max-height var(--easyview-toolbar-collapse-ms, 180ms) var(--easyview-toolbar-collapse-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        min-height var(--easyview-toolbar-collapse-ms, 180ms) var(--easyview-toolbar-collapse-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        height var(--easyview-toolbar-collapse-ms, 180ms) var(--easyview-toolbar-collapse-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        opacity var(--easyview-toolbar-collapse-ms, 180ms) var(--easyview-toolbar-collapse-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        transform var(--easyview-toolbar-collapse-ms, 180ms) var(--easyview-toolbar-collapse-ease, cubic-bezier(0.4, 0, 0.2, 1)),
        padding var(--easyview-toolbar-collapse-ms, 180ms) var(--easyview-toolbar-collapse-ease, cubic-bezier(0.4, 0, 0.2, 1));
    }
    body.easyview-vscode-editor:not(.easyview-toolbar-collapsed) .file-header-bar {
      transform: none;
      opacity: 1;
      overflow: visible;
    }
    body.easyview-vscode-editor:not(.easyview-toolbar-collapsed) #editor-body { height: auto !important; }
    body.easyview-vscode-editor.easyview-toolbar-collapsed .file-header-bar {
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      overflow: hidden;
      opacity: 0 !important;
      transform: translateY(-6px);
      padding-top: 0 !important;
      padding-bottom: 0 !important;
      border-bottom-width: 0 !important;
      pointer-events: none !important;
    }
    .file-header-show-toolbar {
      position: fixed;
      top: 8px;
      right: 12px;
      z-index: 999;
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, .35));
      border-radius: 4px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-foreground, inherit);
      cursor: pointer;
    }
    .file-header-show-toolbar:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }
    body.easyview-toolbar-collapsed .file-header-show-toolbar { display: inline-flex; }
    .file-header-name {
      font-size: 15.6px;
      padding: 0 4.8px;
      line-height: 1.2;
    }
    .file-header-actions {
      gap: 2.4px;
      min-width: 0;
    }
    .file-header-btn {
      height: 26.4px;
      padding: 0 4.8px;
      font-size: 13.2px;
    }
    .file-header-btn svg {
      width: 16.8px;
      height: 16.8px;
    }
    .file-header-zoom {
      gap: 1.2px;
      margin-left: 2.4px;
    }
    .file-header-zoom-btn {
      width: 26.4px;
      min-width: 26.4px;
      height: 26.4px;
    }
    .file-header-zoom-label {
      min-width: 38.4px;
      height: 26.4px;
      font-size: 13.2px;
    }
    .file-header-accent-wrap {
      position: relative;
    }
    .file-header-accent-select {
      height: 26.4px;
      min-width: 86.4px;
      padding: 0 7.2px;
      font-size: 13.2px;
      font-family: inherit;
      display: inline-flex;
      align-items: center;
      gap: 7.2px;
      cursor: pointer;
      color-scheme: inherit;
      background: var(--vscode-input-background, var(--vscode-editor-background, transparent));
      color: var(--vscode-input-foreground, var(--vscode-editor-foreground));
      border: 1px solid var(--vscode-input-border, var(--vscode-dropdown-border, rgba(128, 128, 128, 0.35)));
      border-radius: 4.8px;
      box-shadow: none;
    }
    body:not([data-mdpre-accent="default"])[data-mdpre-accent] .file-header-accent-select {
      border-color: var(--vscode-input-border, var(--vscode-dropdown-border, rgba(128, 128, 128, 0.35))) !important;
      box-shadow: none !important;
      color: var(--mdpre-accent-text, var(--mdpre-accent));
    }
    .file-header-accent-select svg {
      width: 12px;
      height: 12px;
      margin-left: auto;
      flex-shrink: 0;
      opacity: 0.72;
    }
    .file-header-accent-menu {
      min-width: 153.6px;
    }
    .file-header-accent-option[data-value="blue"] { color: #2563eb !important; }
    .file-header-accent-option[data-value="orangeRed"] { color: #ea580c !important; }
    .file-header-accent-option[data-value="green"] { color: #15803d !important; }
    .file-header-accent-option[data-value="purple"] { color: #7c3aed !important; }
    .file-header-accent-option[data-value="cherryRed"] { color: #a6113a !important; }
    body.mdpre-dark .file-header-accent-option[data-value="blue"] { color: #60a5fa !important; }
    body.mdpre-dark .file-header-accent-option[data-value="orangeRed"] { color: #fb923c !important; }
    body.mdpre-dark .file-header-accent-option[data-value="green"] { color: #4ade80 !important; }
    body.mdpre-dark .file-header-accent-option[data-value="purple"] { color: #a78bfa !important; }
    body.mdpre-dark .file-header-accent-option[data-value="cherryRed"] { color: #ff1f4f !important; }
    .file-header-accent-option.active {
      font-weight: 650;
    }
    body.mdpre-light,
    body.mdpre-gray {
      --vscode-dropdown-background: #ffffff;
      --vscode-dropdown-foreground: #1f2328;
      --vscode-dropdown-border: #d0d7de;
    }
    body.mdpre-gray {
      --vscode-dropdown-background: #c2c7d0;
      --vscode-dropdown-foreground: #050608;
      --vscode-dropdown-border: #8e96a3;
    }
    body.mdpre-light .file-header-accent-select,
    body.mdpre-gray .file-header-accent-select {
      background: var(--vscode-editor-background, #ffffff);
      border-color: var(--vscode-input-border, #d0d7de);
    }
    body.mdpre-light[data-mdpre-accent="default"] .file-header-accent-select,
    body.mdpre-gray[data-mdpre-accent="default"] .file-header-accent-select {
      color: var(--vscode-editor-foreground, #1f2328);
    }
    .file-header-theme-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .file-header-theme-depth {
      position: absolute;
      top: calc(100% + 6px);
      left: 50%;
      transform: translateX(-50%);
      width: 28px;
      height: 96px;
      padding: 8px 0;
      border-radius: 999px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #252526));
      border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35));
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.22);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1300;
      touch-action: none;
      user-select: none;
      pointer-events: auto;
    }
    /* Invisible bridge so the pointer can cross the gap without losing hover. */
    .file-header-theme-depth::before {
      content: "";
      position: absolute;
      left: 50%;
      top: -14px;
      width: 40px;
      height: 14px;
      transform: translateX(-50%);
    }
    .file-header-theme-wrap:hover .file-header-theme-depth,
    .file-header-theme-wrap.depth-open .file-header-theme-depth,
    .file-header-theme-wrap.depth-dragging .file-header-theme-depth {
      display: flex;
    }
    .file-header-theme-depth-track {
      position: relative;
      width: 4px;
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(
        to bottom,
        color-mix(in srgb, var(--vscode-editor-foreground, #ccc) 18%, transparent),
        color-mix(in srgb, var(--vscode-editor-foreground, #ccc) 55%, transparent)
      );
    }
    .file-header-theme-depth-thumb {
      position: absolute;
      left: 50%;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      background: var(--vscode-editor-foreground, #d4d4d4);
      border: 2px solid var(--vscode-editor-background, #1e1e1e);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
      cursor: ns-resize;
      touch-action: none;
    }
  `;
  document.head.appendChild(style);
}

function ensureCommitModalStyles(): void {
  const styleId = 'easyview-commit-modal-styles';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .file-header-commit-backdrop {
      position: fixed;
      inset: 0;
      z-index: 10020;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.22);
    }
    .file-header-commit-backdrop.open {
      display: flex;
    }
    .file-header-commit-modal {
      width: min(560px, calc(100vw - 40px));
      border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.28));
      border-radius: 12px;
      background: var(--vscode-editor-background, #fff);
      color: var(--vscode-editor-foreground, #222);
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.28);
      overflow: hidden;
    }
    .file-header-commit-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 24px;
      padding: 4px 12px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.22));
      font-weight: 650;
      font-size: 13px;
      color: var(--mdpre-accent, var(--vscode-textLink-foreground, #0ea5e9));
    }
    .file-header-commit-close {
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 1px 5px;
      border-radius: 6px;
    }
    .file-header-commit-close:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(127, 127, 127, 0.14));
    }
    .file-header-commit-body {
      padding: 14px;
    }
    .file-header-commit-input-wrap {
      position: relative;
    }
    .file-header-commit-textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 108px;
      resize: vertical;
      border: 1px solid var(--vscode-input-border, rgba(127, 127, 127, 0.28));
      border-radius: 8px;
      padding: 30px 12px 10px;
      color: var(--vscode-input-foreground, inherit);
      background: var(--vscode-input-background, transparent);
      font: 13px/1.5 var(--vscode-editor-font-family, Menlo, Consolas, monospace);
      outline: none;
    }
    .file-header-commit-textarea:focus {
      border-color: var(--mdpre-accent, var(--vscode-focusBorder, #0ea5e9));
      box-shadow: 0 0 0 1px var(--mdpre-accent, var(--vscode-focusBorder, #0ea5e9));
    }
    .file-header-commit-source {
      position: absolute;
      top: 8px;
      right: 10px;
      z-index: 1;
      display: none;
      max-width: calc(100% - 20px);
      padding-left: 8px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.9));
      background: var(--vscode-input-background, var(--vscode-editor-background, transparent));
      font-size: 11px;
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-header-commit-source.visible {
      display: block;
    }
    .file-header-commit-loading {
      position: absolute;
      inset: 1px;
      z-index: 2;
      display: none;
      align-items: center;
      justify-content: center;
      gap: 10px;
      border-radius: 8px;
      color: var(--vscode-descriptionForeground, rgba(127, 127, 127, 0.9));
      background: color-mix(in srgb, var(--vscode-input-background, var(--vscode-editor-background, #fff)) 88%, transparent);
      font-size: 13px;
      pointer-events: none;
    }
    .file-header-commit-loading.open {
      display: flex;
    }
    .file-header-commit-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(127, 127, 127, 0.28);
      border-top-color: var(--mdpre-accent, var(--vscode-textLink-foreground, #0ea5e9));
      border-radius: 999px;
      animation: easyview-commit-spin 0.8s linear infinite;
    }
    .file-header-commit-loading-dots::after {
      content: '';
      animation: easyview-commit-dots 1.2s steps(4, end) infinite;
    }
    @keyframes easyview-commit-spin {
      to { transform: rotate(360deg); }
    }
    @keyframes easyview-commit-dots {
      0% { content: ''; }
      25% { content: '.'; }
      50% { content: '..'; }
      75%, 100% { content: '...'; }
    }
    .file-header-commit-status {
      min-height: 18px;
      margin-top: 8px;
      font-size: 12px;
      opacity: 0.78;
    }
    .file-header-commit-status.error {
      color: var(--vscode-errorForeground, #f87171);
      opacity: 1;
    }
    .file-header-commit-actions {
      display: flex;
      justify-content: center;
      gap: 8px;
      padding: 0 14px 14px;
    }
    .file-header-commit-btn {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 7px;
      padding: 6px 12px;
      cursor: pointer;
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground, inherit));
      background: var(--vscode-button-secondaryBackground, rgba(127, 127, 127, 0.15));
    }
    .file-header-commit-btn.primary {
      color: var(--vscode-button-foreground, #fff);
      background: var(--mdpre-accent, var(--vscode-button-background, #0e639c));
    }
    .file-header-commit-btn.sync {
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-gitDecoration-addedResourceForeground, #22c55e);
    }
    .file-header-commit-btn:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
  `;
  document.head.appendChild(style);
}

export interface FileHeader {
  el: HTMLElement;
  getName(): string;
  setName: (name: string) => void;
  setCollapseHandler: (handler: () => void) => void;
  setTocHandler: (handler: () => void) => void;
  setExportHtmlLightHandler: (handler: () => void) => void;
  setExportHtmlDarkHandler: (handler: () => void) => void;
  setExportPdfLightHandler: (handler: () => void) => void;
  setExportPdfDarkHandler: (handler: () => void) => void;
  setExportDocxHandler: (handler: () => void) => void;
  setSourceHandler: (handler: () => void) => void;
  setScrollTopHandler: (handler: () => void) => void;
  setScrollBottomHandler: (handler: () => void) => void;
  setStageHandler: (handler: () => void) => void;
  setCommitHandler: (handler: () => void) => void;
  setCommitConfirmHandler: (handler: (message: string) => void) => void;
  setCommitSyncHandler: (handler: (message: string) => void) => void;
  setTerminalHandler: (handler: () => void) => void;
  setHistoryHandler: (handler: () => void) => void;
  setAiChatHandler: (handler: () => void) => void;
  setStickyNoteHandler: (handler: () => void) => void;
  setExternalFollowHandler: (handler: (enabled: boolean) => void) => void;
  setViewChangesHandler: (handler: () => void) => void;
  syncViewChangesState: (enabled: boolean, available: boolean) => void;
  setShortcutChangeHandler: (handler: (config: ToolbarShortcutConfig) => void) => void;
  getShortcutConfig: () => ToolbarShortcutConfig;
  syncTocState: (visible: boolean) => void;
  syncFullWidthState: (fullWidth: boolean) => void;
  syncTableWrapState: (enabled: boolean) => void;
  syncStickyNoteState: (open: boolean) => void;
  syncAiChatState: (open: boolean) => void;
  triggerTocToggle: () => void;
  triggerWidthToggle: () => void;
  triggerTableWrapToggle: () => void;
  triggerExternalFollowToggle: () => void;
  triggerThemeToggle: () => void;
  triggerViewChanges: () => void;
  getThemeState: () => { mode: ThemeModeName; depth: number };
  cycleTheme: () => void;
  setThemeMode: (mode: ThemeModeName) => void;
  setThemeDepth: (depth: number) => void;
  getAccentTheme: () => EasyViewAccentTheme;
  setAccentTheme: (theme: EasyViewAccentTheme) => void;
  openCommitModal: () => void;
  closeCommitModal: () => void;
  setCommitMessageLoading: (loading: boolean) => void;
  setCommitMessage: (message: string, status?: string) => void;
  setCommitError: (message: string) => void;
  setCommitInProgress: (busy: boolean, mode?: 'commit' | 'sync') => void;
  syncTerminalState: (open: boolean) => void;
  getSourceBtn: () => HTMLElement;
  getHistoryBtn: () => HTMLElement;
  destroy: () => void;
}

export function createFileHeader(deps: FileHeaderDeps): FileHeader {
  const { postMessage, getState, setState, onSettingsChange, capabilities } = deps;
  const dom = deps.dom ?? createEditorDomContext();
  const document = dom.document;
  const window = dom.window;
  ensureFileHeaderCompactStyles();
  ensureCommitModalStyles();
  type ThemeMode = ThemeModeName;
  const accentThemes: Array<{ value: EasyViewAccentTheme; label: string }> = [
    { value: 'default', label: tFileHeader('accent.default') },
    { value: 'blue', label: tFileHeader('accent.blue') },
    { value: 'orangeRed', label: tFileHeader('accent.orangeRed') },
    { value: 'green', label: tFileHeader('accent.green') },
    { value: 'purple', label: tFileHeader('accent.purple') },
    { value: 'cherryRed', label: tFileHeader('accent.cherryRed') },
  ];

  const defaultMode = dom.themeRoot.classList.contains('vscode-dark')
    || (!dom.themeRoot.classList.contains('vscode-light') && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    ? 'dark' : 'light';
  const appearance = deps.appearance ?? new EditorAppearanceStore(window.localStorage, defaultMode);

  const bar = document.createElement('div');
  bar.className = 'file-header-bar';
  let moreMenu: HTMLElement | null = null;
  let showToolbarBtn: HTMLButtonElement | null = null;
  let toolbarResizeObserver: ResizeObserver | null = null;

  let shortcutConfig = readStoredShortcuts();
  let shortcutChangeHandler: ((config: ToolbarShortcutConfig) => void) | null = null;
  let externalFollowEnabled = readStoredExternalFollowEnabled();
  let externalFollowHandler: ((enabled: boolean) => void) | null = null;
  let viewChangesHandler: (() => void) | null = null;
  let viewChangesEnabled = false;
  let viewChangesAvailable = false;
  let commitConfirmHandler: ((message: string) => void) | null = null;
  let commitSyncHandler: ((message: string) => void) | null = null;
  let commitModalBusy = false;



  const nameEl = document.createElement('span');
  nameEl.className = 'file-header-name';
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.title = tFileHeader('rename');

  nameEl.addEventListener('keydown', (e) => {
    if (e.code === 'Enter' || e.code === 'Escape') {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
  });

  nameEl.addEventListener('blur', () => {
    const newName = nameEl.textContent?.trim();
    if (newName) {
      postMessage({ type: 'rename', newName });
    }
  });

  const shortcutLabel = (action: ToolbarShortcutAction): string => {
    const value = shortcutConfig[action];
    return value ? toDisplayShortcut(value) : tFileHeader('unassigned');
  };

  const setTitleWithShortcut = (element: HTMLElement, text: string, action?: ToolbarShortcutAction): void => {
    element.title = action ? `${text} (${shortcutLabel(action)})` : text;
    if (deps.toolbarOnly) element.setAttribute('aria-label', text);
  };

  const syncTocButton = (visible: boolean): void => {
    tocBtn.classList.toggle('active', visible);
    setTitleWithShortcut(tocBtn, visible ? tFileHeader('toc.hide') : tFileHeader('toc.toggle'), 'toggleToc');
  };

  const syncWidthButton = (fullWidth: boolean): void => {
    widthBtn.classList.toggle('active', fullWidth);
    widthBtn.innerHTML = fullWidth
      ? '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M4 14h6v6\"/><path d=\"M20 10h-6V4\"/><path d=\"M14 10l7-7\"/><path d=\"M3 21l7-7\"/></svg>'
      : '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M15 3h6v6\"/><path d=\"M9 21H3v-6\"/><path d=\"M21 3l-7 7\"/><path d=\"M3 21l7-7\"/></svg>';
    setTitleWithShortcut(widthBtn, fullWidth ? tFileHeader('width.exit') : tFileHeader('width.expand'), 'toggleFullWidth');
  };

  const syncTableWrapButton = (enabled: boolean): void => {
    tableWrapBtn.classList.toggle('active', enabled);
    setTitleWithShortcut(tableWrapBtn, enabled ? tFileHeader('tableWrap.disable') : tFileHeader('tableWrap.enable'), 'toggleTableWrap');
  };

  const syncExternalFollowButton = (enabled: boolean): void => {
    externalFollowBtn.classList.toggle('active', enabled);
    externalFollowBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    setTitleWithShortcut(
      externalFollowBtn,
      enabled ? tFileHeader('externalFollow.disable') : tFileHeader('externalFollow.enable'),
      'toggleExternalFollow'
    );
  };

  // Left group (TOC, collapse, width buttons)
  const leftGroup = document.createElement('div');
  leftGroup.className = 'file-header-actions file-header-actions-left';

  const tocBtn = document.createElement('button');
  tocBtn.className = 'file-header-btn active';
  tocBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="17" y2="18"/></svg>';
  leftGroup.appendChild(tocBtn);

  let allCollapsed = false;
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'file-header-btn';
  collapseBtn.title = tFileHeader('headings.collapse');
  collapseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
  leftGroup.appendChild(collapseBtn);

  const widthBtn = document.createElement('button');
  widthBtn.className = 'file-header-btn active';
  widthBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>';
  widthBtn.addEventListener('click', () => {
    const state = getState();
    const newFullWidth = !state.isFullWidth;
    setState({ isFullWidth: newFullWidth });
    dom.getById('editor')?.classList.toggle('full-width', newFullWidth);
    syncWidthButton(newFullWidth);
    dom.eventTarget.dispatchEvent(new CustomEvent('easyview-editor-layout-change'));
    onSettingsChange();
  });
  leftGroup.appendChild(widthBtn);

  const tableWrapBtn = document.createElement('button');
  tableWrapBtn.className = 'file-header-btn';
  tableWrapBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><polyline points="16 16 14 18 16 20"/><line x1="3" y1="18" x2="10" y2="18"/></svg>';
  tableWrapBtn.addEventListener('click', () => {
    const state = getState();
    const newTableWrap = !state.isTableWrap;
    setState({ isTableWrap: newTableWrap });
    dom.getById('editor')?.classList.toggle('table-wrap', newTableWrap);
    dom.eventTarget.dispatchEvent(new CustomEvent('easyview-table-wrap-layout-change'));
    syncTableWrapButton(newTableWrap);
    onSettingsChange();
  });
  leftGroup.appendChild(tableWrapBtn);

  // Zoom controls
  const ZOOM_MIN = 50, ZOOM_MAX = 200, ZOOM_STEP = 10;
  let zoomLevel = 100;
  const zoomGroup = document.createElement('div');
  zoomGroup.className = 'file-header-zoom';
  const zoomOutBtn = document.createElement('button');
  zoomOutBtn.className = 'file-header-btn file-header-zoom-btn';
  zoomOutBtn.title = tFileHeader('zoom.out');
  zoomOutBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'file-header-zoom-label';
  zoomLabel.textContent = '100%';
  zoomLabel.title = tFileHeader('zoom.reset');
  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'file-header-btn file-header-zoom-btn';
  zoomInBtn.title = tFileHeader('zoom.in');
  zoomInBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  function applyZoom(level: number) {
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
    zoomLabel.textContent = `${zoomLevel}%`;
    const scrollArea = dom.getById('editor-scroll-area');
    if (scrollArea) scrollArea.style.fontSize = `${zoomLevel}%`;
    dom.eventTarget.dispatchEvent(new CustomEvent('easyview-editor-layout-change'));
    zoomOutBtn.classList.toggle('disabled', zoomLevel <= ZOOM_MIN);
    zoomInBtn.classList.toggle('disabled', zoomLevel >= ZOOM_MAX);
  }
  zoomOutBtn.addEventListener('click', () => applyZoom(zoomLevel - ZOOM_STEP));
  zoomInBtn.addEventListener('click', () => applyZoom(zoomLevel + ZOOM_STEP));
  zoomLabel.addEventListener('click', () => applyZoom(100));
  zoomGroup.appendChild(zoomOutBtn);
  zoomGroup.appendChild(zoomLabel);
  zoomGroup.appendChild(zoomInBtn);
  leftGroup.appendChild(zoomGroup);
  const onDocumentWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      applyZoom(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }
  };
  dom.root.addEventListener('wheel', onDocumentWheel as EventListener, { passive: false });

  // Right group
  const rightGroup = document.createElement('div');
  rightGroup.className = 'file-header-actions file-header-actions-right';

  const scrollTopBtn = document.createElement('button');
  scrollTopBtn.className = 'file-header-btn';
  scrollTopBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V9"/><path d="m17 14-5-5-5 5"/><path d="M5 3h14"/></svg>';
  rightGroup.appendChild(scrollTopBtn);

  const scrollBottomBtn = document.createElement('button');
  scrollBottomBtn.className = 'file-header-btn';
  scrollBottomBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  rightGroup.appendChild(scrollBottomBtn);

  const stageBtn = document.createElement('button');
  stageBtn.className = 'file-header-btn';
  stageBtn.dataset.action = 'stageFile';
  stageBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 6.5c-1.1-1.1-2.6-1.7-4.5-1.7-2.8 0-4.8 1.3-4.8 3.5 0 1.9 1.5 2.9 4.4 3.5l1.2.3c2.6.6 3.8 1.4 3.8 3.2 0 2.4-2.1 3.8-5 3.8-2 0-3.7-.6-5-1.8"/></svg>';
  if (capabilities.git) rightGroup.appendChild(stageBtn);

  const commitBtn = document.createElement('button');
  commitBtn.className = 'file-header-btn';
  commitBtn.dataset.action = 'commitFile';
  commitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/><path d="M12 3v6"/><path d="M12 15v6"/></svg>';
  if (capabilities.git) rightGroup.appendChild(commitBtn);

  const terminalBtn = document.createElement('button');
  terminalBtn.className = 'file-header-btn';
  terminalBtn.dataset.action = 'toggleTerminal';
  terminalBtn.title = tFileHeader('terminal.open');
  terminalBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="m7 9 3 3-3 3"/><path d="M12 15h5"/></svg>';
  if (capabilities.terminal) rightGroup.appendChild(terminalBtn);

  const historyBtn = document.createElement('button');
  historyBtn.className = 'file-header-btn';
  historyBtn.title = tFileHeader('history.toggle');
  historyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  rightGroup.appendChild(historyBtn);

  const aiChatBtn = document.createElement('button');
  aiChatBtn.className = 'file-header-btn';
  aiChatBtn.title = tFileHeader('aiChat.toggle');
  aiChatBtn.innerHTML = AI_CHAT_ICON_HTML;
  if (capabilities.aiChat) rightGroup.appendChild(aiChatBtn);

  const stickyNoteBtn = document.createElement('button');
  stickyNoteBtn.className = 'file-header-btn';
  stickyNoteBtn.title = tFileHeader('stickyNote.toggle');
  stickyNoteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>';
  rightGroup.appendChild(stickyNoteBtn);

  const sourceBtn = document.createElement('button');
  sourceBtn.className = 'file-header-btn';
  sourceBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  rightGroup.appendChild(sourceBtn);

  // Export dropdown
  const exportWrapper = document.createElement('div');
  exportWrapper.className = 'file-header-export-wrapper';
  const exportBtn = document.createElement('button');
  exportBtn.className = 'file-header-btn';
  exportBtn.title = tFileHeader('export');
  exportBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  exportWrapper.appendChild(exportBtn);

  const exportDropdown = document.createElement('div');
  exportDropdown.className = 'file-header-dropdown';

  const exportHtmlLightItem = document.createElement('button');
  exportHtmlLightItem.className = 'file-header-dropdown-item';
  exportHtmlLightItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> ' + escapeHtml(tFileHeader('export.htmlLight'));

  const exportHtmlDarkItem = document.createElement('button');
  exportHtmlDarkItem.className = 'file-header-dropdown-item';
  exportHtmlDarkItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> ' + escapeHtml(tFileHeader('export.htmlDark'));

  const exportPdfLightItem = document.createElement('button');
  exportPdfLightItem.className = 'file-header-dropdown-item';
  exportPdfLightItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ' + escapeHtml(tFileHeader('export.pdfLight'));

  const exportPdfDarkItem = document.createElement('button');
  exportPdfDarkItem.className = 'file-header-dropdown-item';
  exportPdfDarkItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ' + escapeHtml(tFileHeader('export.pdfDark'));

  const exportDocxItem = document.createElement('button');
  exportDocxItem.className = 'file-header-dropdown-item';
  exportDocxItem.dataset.action = 'exportDocx';
  exportDocxItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> ' + escapeHtml(tFileHeader('export.docx'));

  exportDropdown.appendChild(exportHtmlLightItem);
  exportDropdown.appendChild(exportHtmlDarkItem);
  exportDropdown.appendChild(exportPdfLightItem);
  exportDropdown.appendChild(exportPdfDarkItem);
  if (capabilities.documentConversion) exportDropdown.appendChild(exportDocxItem);
  exportWrapper.appendChild(exportDropdown);
  rightGroup.appendChild(exportWrapper);

  const themeWrap = document.createElement('div');
  themeWrap.className = 'file-header-theme-wrap';
  const themeToggleBtn = document.createElement('button');
  themeToggleBtn.className = 'file-header-btn';
  themeToggleBtn.type = 'button';

  let depthDragging = false;
  let suppressThemeClick = false;
  let depthCloseTimer: number | null = null;
  let suppressThemeClickTimer: number | null = null;
  let destroyed = false;
  const DEPTH_CLOSE_DELAY_MS = 280;
  const THEME_ICONS: Record<ThemeMode, string> = {
    // Icon represents the current mode.
    light: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    gray: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none"/></svg>',
    dark: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z"/></svg>',
  };
  const THEME_TITLES: Record<ThemeMode, string> = {
    light: tFileHeader('theme.light'),
    gray: tFileHeader('theme.gray'),
    dark: tFileHeader('theme.dark'),
  };

  const depthPanel = document.createElement('div');
  depthPanel.className = 'file-header-theme-depth';
  depthPanel.title = tFileHeader('theme.depth');
  const depthTrack = document.createElement('div');
  depthTrack.className = 'file-header-theme-depth-track';
  const depthThumb = document.createElement('div');
  depthThumb.className = 'file-header-theme-depth-thumb';
  depthTrack.appendChild(depthThumb);
  depthPanel.appendChild(depthTrack);

  function syncDepthThumb(): void {
    depthThumb.style.top = `${appearance.state.depth * 100}%`;
  }

  function applyThemeDepth(depth: number): void {
    appearance.setDepth(depth);
  }

  function renderAppearance(state: Readonly<EditorAppearanceState>): void {
    applyEditorAppearance(dom.themeRoot, state);
    if (!deps.appearance) document.documentElement.dataset.easyviewTheme = state.mode;
    themeToggleBtn.classList.toggle('active', state.mode !== 'light');
    setTitleWithShortcut(themeToggleBtn, THEME_TITLES[state.mode], 'toggleTheme');
    themeToggleBtn.innerHTML = THEME_ICONS[state.mode];
    syncDepthThumb();
    syncAccentTheme(state.accent);
    const detail = { mode: state.mode, isDark: state.mode === 'dark', depth: state.depth };
    dom.eventTarget.dispatchEvent(new CustomEvent('inlinemd:themeChanged', { detail }));
    if (!deps.appearance) window.dispatchEvent(new CustomEvent('easyview:productThemeChanged', { detail }));
  }

  function applyThemeMode(mode: ThemeMode, options?: { notifyHost?: boolean }): void {
    appearance.setMode(mode);
    if (options?.notifyHost !== false) postMessage({ type: 'productThemeChanged', mode });
  }

  function depthFromClientY(clientY: number): number {
    const rect = depthTrack.getBoundingClientRect();
    if (rect.height <= 0) return appearance.state.depth;
    return (clientY - rect.top) / rect.height;
  }

  function clearDepthCloseTimer(): void {
    if (depthCloseTimer == null) return;
    window.clearTimeout(depthCloseTimer);
    depthCloseTimer = null;
  }

  function openDepthPanel(): void {
    clearDepthCloseTimer();
    themeWrap.classList.add('depth-open');
  }

  function scheduleCloseDepthPanel(): void {
    if (depthDragging) return;
    clearDepthCloseTimer();
    depthCloseTimer = window.setTimeout(() => {
      depthCloseTimer = null;
      if (depthDragging) return;
      themeWrap.classList.remove('depth-open');
    }, DEPTH_CLOSE_DELAY_MS);
  }

  function onDepthPointerMove(event: PointerEvent): void {
    if (!depthDragging) return;
    applyThemeDepth(depthFromClientY(event.clientY));
  }

  function onDepthPointerUp(event: PointerEvent): void {
    if (!depthDragging) return;
    depthDragging = false;
    themeWrap.classList.remove('depth-dragging');
    depthThumb.releasePointerCapture?.(event.pointerId);
    window.removeEventListener('pointermove', onDepthPointerMove);
    window.removeEventListener('pointerup', onDepthPointerUp);
    window.removeEventListener('pointercancel', onDepthPointerUp);
    // Prevent the trailing click from cycling theme after a drag.
    suppressThemeClick = true;
    if (suppressThemeClickTimer != null) window.clearTimeout(suppressThemeClickTimer);
    suppressThemeClickTimer = window.setTimeout(() => {
      suppressThemeClick = false;
      suppressThemeClickTimer = null;
    }, 0);
    if (!themeWrap.matches(':hover')) {
      scheduleCloseDepthPanel();
    }
  }

  depthThumb.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openDepthPanel();
    depthDragging = true;
    themeWrap.classList.add('depth-dragging');
    depthThumb.setPointerCapture?.(event.pointerId);
    applyThemeDepth(depthFromClientY(event.clientY));
    window.addEventListener('pointermove', onDepthPointerMove);
    window.addEventListener('pointerup', onDepthPointerUp);
    window.addEventListener('pointercancel', onDepthPointerUp);
  });

  depthTrack.addEventListener('pointerdown', (event) => {
    if (event.target === depthThumb) return;
    event.preventDefault();
    event.stopPropagation();
    openDepthPanel();
    depthDragging = true;
    themeWrap.classList.add('depth-dragging');
    applyThemeDepth(depthFromClientY(event.clientY));
    depthThumb.setPointerCapture?.(event.pointerId);
    window.addEventListener('pointermove', onDepthPointerMove);
    window.addEventListener('pointerup', onDepthPointerUp);
    window.addEventListener('pointercancel', onDepthPointerUp);
  });

  themeWrap.addEventListener('pointerenter', openDepthPanel);
  themeWrap.addEventListener('pointerleave', scheduleCloseDepthPanel);

  themeToggleBtn.addEventListener('click', (event) => {
    if (suppressThemeClick) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    applyThemeMode(nextEasyViewThemeMode(appearance.state.mode), { notifyHost: true });
  });
  themeWrap.appendChild(themeToggleBtn);
  themeWrap.appendChild(depthPanel);
  rightGroup.appendChild(themeWrap);

  const viewChangesBtn = document.createElement('button');
  viewChangesBtn.type = 'button';
  viewChangesBtn.className = 'file-header-btn';
  viewChangesBtn.dataset.action = 'toggleViewChanges';
  viewChangesBtn.title = tFileHeader('viewChanges');
  viewChangesBtn.setAttribute('aria-label', tFileHeader('viewChanges'));
  viewChangesBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 12h10M4 19h16"/><path d="m17 9 3 3-3 3"/></svg>';
  viewChangesBtn.disabled = true;
  viewChangesBtn.setAttribute('aria-disabled', 'true');
  viewChangesBtn.addEventListener('click', () => {
    if (viewChangesBtn.disabled) return;
    viewChangesHandler?.();
  });
  if (capabilities.git) rightGroup.appendChild(viewChangesBtn);

  const externalFollowBtn = document.createElement('button');
  externalFollowBtn.type = 'button';
  externalFollowBtn.className = 'file-header-btn';
  externalFollowBtn.dataset.action = 'toggleExternalFollow';
  externalFollowBtn.setAttribute('aria-label', tFileHeader('externalFollow.toggle'));
  externalFollowBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 18 6-6-6-6"/><circle cx="6" cy="12" r="2"/></svg>';
  externalFollowBtn.addEventListener('click', (event) => {
    event.preventDefault();
    externalFollowEnabled = !externalFollowEnabled;
    syncExternalFollowButton(externalFollowEnabled);
    try {
      localStorage.setItem(EXTERNAL_FOLLOW_STORAGE_KEY, String(externalFollowEnabled));
    } catch {
      // Storage can be unavailable in restricted contexts.
    }
    externalFollowHandler?.(externalFollowEnabled);
  });
  syncExternalFollowButton(externalFollowEnabled);
  rightGroup.appendChild(externalFollowBtn);

  const accentWrap = document.createElement('div');
  accentWrap.className = 'file-header-export-wrapper file-header-accent-wrap';
  const accentSelect = document.createElement('button');
  accentSelect.type = 'button';
  accentSelect.className = 'file-header-accent-select';
  accentSelect.title = tFileHeader('accent.choose');
  const accentLabel = document.createElement('span');
  accentSelect.appendChild(accentLabel);
  accentSelect.insertAdjacentHTML(
    'beforeend',
    '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
  );
  const accentMenu = document.createElement('div');
  accentMenu.className = 'file-header-dropdown file-header-accent-menu';
  const accentOptionEls = new Map<EasyViewAccentTheme, HTMLButtonElement>();
  const accentThemeColors: Record<Exclude<EasyViewAccentTheme, 'default'>, { light: string; gray: string; dark: string }> = {
    blue: { light: '#2563eb', gray: '#2563eb', dark: '#60a5fa' },
    orangeRed: { light: '#ea580c', gray: '#ea580c', dark: '#fb923c' },
    green: { light: '#15803d', gray: '#15803d', dark: '#4ade80' },
    purple: { light: '#7c3aed', gray: '#7c3aed', dark: '#a78bfa' },
    cherryRed: { light: '#a6113a', gray: '#a6113a', dark: '#ff1f4f' },
  };
  function accentOptionColor(theme: EasyViewAccentTheme): string {
    if (theme === 'default') return '';
    return accentThemeColors[theme][appearance.state.mode];
  }
  function syncAccentTheme(theme: EasyViewAccentTheme) {
    const selected = accentThemes.find((item) => item.value === theme) ?? accentThemes[0];
    accentLabel.textContent = selected.label;
    const selectedColor = accentOptionColor(theme);
    // Desktop toolbar styles force control colours with !important.
    if (selectedColor) accentLabel.style.setProperty('color', selectedColor, 'important');
    else accentLabel.style.removeProperty('color');
    for (const item of accentThemes) {
      const optionEl = accentOptionEls.get(item.value);
      if (!optionEl) continue;
      optionEl.classList.toggle('active', item.value === theme);
      optionEl.style.color = accentOptionColor(item.value);
    }
  }
  for (const theme of accentThemes) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'file-header-dropdown-item file-header-accent-option';
    option.dataset.value = theme.value;
    option.textContent = theme.label;
    option.addEventListener('click', (event) => {
      event.stopPropagation();
      appearance.setAccent(theme.value);
      accentMenu.classList.remove('open');
    });
    accentOptionEls.set(theme.value, option);
    accentMenu.appendChild(option);
  }
  accentSelect.addEventListener('click', (event) => {
    event.stopPropagation();
    exportDropdown.classList.remove('open');
    accentMenu.classList.toggle('open');
  });
  const appearanceSubscription = appearance.subscribe(renderAppearance);
  renderAppearance(appearance.state);
  accentWrap.appendChild(accentSelect);
  accentWrap.appendChild(accentMenu);
  rightGroup.appendChild(accentWrap);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'file-header-btn';
  settingsBtn.title = tFileHeader('shortcuts.configure');
  settingsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.5.2 1.06 0 1.56.5.2 1.06.2 1.56 0H21a2 2 0 1 1 0 4h-.09c-.45 0-.88.18-1.2.44z"/></svg>';
  rightGroup.appendChild(settingsBtn);

  const shortcutsBackdrop = document.createElement('div');
  shortcutsBackdrop.className = 'file-header-shortcuts-backdrop';
  shortcutsBackdrop.innerHTML = `
    <div class="file-header-shortcuts-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(tFileHeader('shortcuts.dialog'))}">
      <div class="file-header-shortcuts-title">${escapeHtml(tFileHeader('shortcuts.title'))}</div>
      <div class="file-header-shortcuts-list"></div>
      <div class="file-header-shortcuts-actions">
        <button class="file-header-shortcuts-btn" data-action="reset">${escapeHtml(tFileHeader('shortcuts.reset'))}</button>
        <button class="file-header-shortcuts-btn primary" data-action="close">${escapeHtml(tFileHeader('shortcuts.done'))}</button>
      </div>
    </div>
  `;
  dom.overlayRoot.appendChild(shortcutsBackdrop);

  const shortcutRows = new Map<ToolbarShortcutAction, HTMLInputElement>();
  const shortcutsList = shortcutsBackdrop.querySelector('.file-header-shortcuts-list') as HTMLElement;

  const createShortcutRow = (action: ToolbarShortcutAction): void => {
    const row = document.createElement('div');
    row.className = 'file-header-shortcuts-row';

    const label = document.createElement('label');
    label.className = 'file-header-shortcuts-label';
    label.textContent = shortcutActionLabel(action);

    const input = document.createElement('input');
    input.className = 'file-header-shortcuts-input';
    input.type = 'text';
    input.readOnly = true;
    input.value = shortcutConfig[action] ? toDisplayShortcut(shortcutConfig[action]) : '';
    input.placeholder = tFileHeader('shortcuts.press');
    input.dataset.action = action;

    input.addEventListener('keydown', (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        input.blur();
        return;
      }

      if (event.key === 'Backspace' || event.key === 'Delete') {
        shortcutConfig[action] = '';
        input.value = '';
        persistShortcuts();
        return;
      }

      const shortcut = formatEventToShortcut(event);
      if (!shortcut) return;

      shortcutConfig[action] = shortcut;
      input.value = toDisplayShortcut(shortcut);
      persistShortcuts();
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'file-header-shortcuts-clear';
    clearBtn.type = 'button';
    clearBtn.textContent = tFileHeader('shortcuts.clear');
    clearBtn.addEventListener('click', () => {
      shortcutConfig[action] = '';
      input.value = '';
      persistShortcuts();
    });

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(clearBtn);
    shortcutsList.appendChild(row);
    shortcutRows.set(action, input);
  };

  (Object.keys(DEFAULT_SHORTCUTS) as ToolbarShortcutAction[])
    .filter((action) => capabilities.shortcutPersistence || action !== 'openWithEasyView')
    .forEach(createShortcutRow);

  const persistShortcuts = (): void => {
    try {
      localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(shortcutConfig));
    } catch {
      // Storage can be unavailable in restricted contexts.
    }
    refreshShortcutAwareTitles();
    shortcutRows.forEach((input, action) => {
      input.value = shortcutConfig[action] ? toDisplayShortcut(shortcutConfig[action]) : '';
    });
    shortcutChangeHandler?.({ ...shortcutConfig });
  };

  const openShortcutModal = (): void => {
    shortcutRows.forEach((input, action) => {
      input.value = shortcutConfig[action] ? toDisplayShortcut(shortcutConfig[action]) : '';
    });
    shortcutsBackdrop.classList.add('open');
  };

  const closeShortcutModal = (): void => {
    shortcutsBackdrop.classList.remove('open');
  };

  settingsBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    openShortcutModal();
  });

  const commitBackdrop = document.createElement('div');
  commitBackdrop.className = 'file-header-commit-backdrop';
  commitBackdrop.innerHTML = `
    <div class="file-header-commit-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(tFileHeader('commit.title'))}">
      <div class="file-header-commit-title">
        <span>${escapeHtml(tFileHeader('commit.title'))}</span>
        <button class="file-header-commit-close" type="button" aria-label="${escapeHtml(tFileHeader('commit.close'))}">x</button>
      </div>
      <div class="file-header-commit-body">
        <div class="file-header-commit-input-wrap">
          <span class="file-header-commit-source"></span>
          <textarea class="file-header-commit-textarea" spellcheck="false" placeholder="${escapeHtml(tFileHeader('commit.placeholder'))}"></textarea>
          <div class="file-header-commit-loading" aria-live="polite">
            <span class="file-header-commit-spinner"></span>
            <span>${escapeHtml(tFileHeader('commit.generating'))}<span class="file-header-commit-loading-dots"></span></span>
          </div>
        </div>
        <div class="file-header-commit-status"></div>
      </div>
      <div class="file-header-commit-actions">
        <button class="file-header-commit-btn" type="button" data-action="cancel">${escapeHtml(tFileHeader('commit.cancel'))}</button>
        <button class="file-header-commit-btn primary" type="button" data-action="commit">${escapeHtml(tFileHeader('commit.commit'))}</button>
        <button class="file-header-commit-btn sync" type="button" data-action="sync">${escapeHtml(tFileHeader('commit.sync'))}</button>
      </div>
    </div>
  `;
  dom.overlayRoot.appendChild(commitBackdrop);

  const commitTextarea = commitBackdrop.querySelector('.file-header-commit-textarea') as HTMLTextAreaElement;
  const commitSource = commitBackdrop.querySelector('.file-header-commit-source') as HTMLElement;
  const commitLoading = commitBackdrop.querySelector('.file-header-commit-loading') as HTMLElement;
  const commitStatus = commitBackdrop.querySelector('.file-header-commit-status') as HTMLElement;
  const commitSubmitBtn = commitBackdrop.querySelector('[data-action="commit"]') as HTMLButtonElement;
  const commitSyncBtn = commitBackdrop.querySelector('[data-action="sync"]') as HTMLButtonElement;
  const commitCancelBtn = commitBackdrop.querySelector('[data-action="cancel"]') as HTMLButtonElement;
  const commitCloseBtn = commitBackdrop.querySelector('.file-header-commit-close') as HTMLButtonElement;

  const updateCommitSubmitState = (): void => {
    const hasMessage = !!commitTextarea.value.trim();
    const disabled = !hasMessage || commitTextarea.disabled;
    commitSubmitBtn.disabled = disabled;
    commitSyncBtn.disabled = disabled;
    commitCancelBtn.disabled = commitModalBusy;
    commitCloseBtn.disabled = commitModalBusy;
  };

  const setCommitStatus = (message: string, isError = false): void => {
    commitStatus.textContent = message;
    commitStatus.classList.toggle('error', isError);
  };

  const openCommitModal = (): void => {
    if (!capabilities.aiCommitMessage) {
      commitModalBusy = false;
      commitTextarea.disabled = false;
      commitTextarea.value = '';
      commitTextarea.placeholder = tFileHeader('commit.placeholder');
      commitLoading.classList.remove('open');
      commitSource.textContent = '';
      commitSource.classList.remove('visible');
      setCommitStatus('');
      updateCommitSubmitState();
    }
    commitBackdrop.classList.add('open');
    commitTextarea.focus();
    commitTextarea.select();
  };

  if (!capabilities.aiCommitMessage) {
    commitBtn.addEventListener('click', openCommitModal);
  }

  commitTextarea.addEventListener('input', updateCommitSubmitState);
  commitTextarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    commitSubmitBtn.click();
  });
  commitBackdrop.addEventListener('click', (event) => {
    if (event.target === commitBackdrop && !commitModalBusy) {
      commitBackdrop.classList.remove('open');
    }
  });
  commitCancelBtn.addEventListener('click', () => {
    if (!commitModalBusy) commitBackdrop.classList.remove('open');
  });
  commitCloseBtn.addEventListener('click', () => {
    if (!commitModalBusy) commitBackdrop.classList.remove('open');
  });
  commitSubmitBtn.addEventListener('click', () => {
    const message = commitTextarea.value.trim();
    if (!message || commitSubmitBtn.disabled) return;
    commitConfirmHandler?.(message);
  });
  commitSyncBtn.addEventListener('click', () => {
    const message = commitTextarea.value.trim();
    if (!message || commitSyncBtn.disabled) return;
    commitSyncHandler?.(message);
  });

  shortcutsBackdrop.addEventListener('click', (event) => {
    if (event.target === shortcutsBackdrop) {
      closeShortcutModal();
    }
  });

  const modalResetBtn = shortcutsBackdrop.querySelector('[data-action="reset"]') as HTMLButtonElement;
  const modalCloseBtn = shortcutsBackdrop.querySelector('[data-action="close"]') as HTMLButtonElement;

  modalResetBtn.addEventListener('click', () => {
    shortcutConfig = { ...DEFAULT_SHORTCUTS };
    persistShortcuts();
    shortcutRows.forEach((input, action) => {
      input.value = shortcutConfig[action] ? toDisplayShortcut(shortcutConfig[action]) : '';
    });
  });

  modalCloseBtn.addEventListener('click', () => closeShortcutModal());

  const onDocumentKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      moreMenu?.classList.remove('open');
      exportDropdown.classList.remove('open');
      accentMenu.classList.remove('open');
      closeShortcutModal();
      if (!commitModalBusy) commitBackdrop.classList.remove('open');
    }
  };
  dom.root.addEventListener('keydown', onDocumentKeydown as EventListener);

  // Toggle dropdown on button click
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    accentMenu.classList.remove('open');
    exportDropdown.classList.toggle('open');
  });

  // Close dropdown on outside click
  const onDocumentClick = (): void => {
    moreMenu?.classList.remove('open');
    exportDropdown.classList.remove('open');
    accentMenu.classList.remove('open');
  };
  dom.root.addEventListener('click', onDocumentClick);

  const refreshShortcutAwareTitles = (): void => {
    const state = getState();
    syncTocButton(state.isTocVisible);
    syncWidthButton(state.isFullWidth);
    syncTableWrapButton(state.isTableWrap);
    setTitleWithShortcut(scrollTopBtn, tFileHeader('shortcut.scrollTop'), 'scrollTop');
    setTitleWithShortcut(scrollBottomBtn, tFileHeader('shortcut.scrollBottom'), 'scrollBottom');
    setTitleWithShortcut(stageBtn, tFileHeader('shortcut.stageFile'), 'stageFile');
    setTitleWithShortcut(commitBtn, tFileHeader('shortcut.commitFile'), 'commitFile');
    setTitleWithShortcut(terminalBtn, tFileHeader('terminal.open'), 'toggleTerminal');
    setTitleWithShortcut(stickyNoteBtn, tFileHeader('stickyNote.toggle'), 'toggleStickyNote');
    setTitleWithShortcut(aiChatBtn, tFileHeader('aiChat.toggle'), 'toggleAiChat');
    setTitleWithShortcut(
      sourceBtn,
      capabilities.sourceMode === 'native' ? tFileHeader('source.native') : tFileHeader('source.toggle'),
      'openSourceMode',
    );
    setTitleWithShortcut(
      viewChangesBtn,
      !viewChangesAvailable
        ? tFileHeader('viewChanges.unavailable')
        : viewChangesEnabled ? tFileHeader('viewChanges.exit') : tFileHeader('viewChanges'),
      'toggleViewChanges',
    );
    syncExternalFollowButton(externalFollowEnabled);
    setTitleWithShortcut(themeToggleBtn, THEME_TITLES[appearance.state.mode], 'toggleTheme');
  };

  refreshShortcutAwareTitles();

  if (deps.toolbarOnly) {
    bar.classList.add('file-header-toolbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', tFileHeader('toolbar.label'));
    const label = (button: HTMLElement, key: Parameters<typeof tFileHeader>[0]): void => {
      button.setAttribute('aria-label', button.title || tFileHeader(key));
    };
    label(tocBtn, 'toolbar.outline');
    label(sourceBtn, 'toolbar.source');
    label(widthBtn, 'toolbar.fullWidth');
    label(tableWrapBtn, 'toolbar.tableWrap');
    label(collapseBtn, 'toolbar.collapse');
    label(historyBtn, 'toolbar.history');
    label(stickyNoteBtn, 'toolbar.stickyNote');
    label(viewChangesBtn, 'viewChanges');
    label(exportBtn, 'export');
    const mounted = new Set<Element>([...leftGroup.children, ...rightGroup.children, zoomGroup]);
    // Lower priority groups move into the overflow menu first; priority 0 groups always stay inline.
    const groupSpecs: Array<{ name: string; priority: number; items: HTMLElement[] }> = [
      { name: 'view', priority: 0, items: [tocBtn, sourceBtn, widthBtn, tableWrapBtn, collapseBtn] },
      { name: 'zoom', priority: 4, items: [zoomGroup] },
      { name: 'navigate', priority: 2, items: [scrollTopBtn, scrollBottomBtn] },
      { name: 'git', priority: 5, items: [viewChangesBtn, stageBtn, commitBtn] },
      { name: 'tools', priority: 3, items: [terminalBtn, historyBtn, stickyNoteBtn, externalFollowBtn] },
      { name: 'output', priority: 6, items: [exportWrapper, themeWrap] },
      { name: 'preferences', priority: 1, items: [accentWrap, settingsBtn] },
    ];
    const groups = groupSpecs
      .map((spec) => {
        const items = spec.items.filter((item) => mounted.has(item));
        if (!items.length) return null;
        const el = document.createElement('div');
        el.className = 'file-header-group';
        el.dataset.group = spec.name;
        el.append(...items);
        return { el, priority: spec.priority };
      })
      .filter((group): group is { el: HTMLDivElement; priority: number } => group !== null);
    leftGroup.replaceChildren();
    rightGroup.replaceChildren();
    const more = document.createElement('div');
    more.className = 'file-header-export-wrapper file-header-more';
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'file-header-btn';
    moreButton.title = tFileHeader('toolbar.more');
    moreButton.setAttribute('aria-label', moreButton.title);
    moreButton.setAttribute('aria-haspopup', 'true');
    moreButton.textContent = '···';
    moreMenu = document.createElement('div');
    moreMenu.className = 'file-header-dropdown';
    for (const group of groups) {
      for (const button of group.el.querySelectorAll<HTMLElement>('.file-header-btn')) {
        if (button.title && !button.closest('.file-header-zoom')) button.dataset.label = button.title.replace(/\s*\([^)]*\)$/, '');
      }
    }
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      exportDropdown.classList.remove('open');
      moreMenu!.classList.toggle('open');
    });
    moreMenu.addEventListener('click', (event) => event.stopPropagation());
    more.append(moreButton, moreMenu);
    more.hidden = true;
    bar.append(...groups.map((group) => group.el), more);

    const contentWidth = (): number => {
      const style = getComputedStyle(bar);
      const gap = parseFloat(style.columnGap) || 0;
      const visible = Array.from(bar.children).filter((child) => !(child as HTMLElement).hidden);
      const width = visible.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
      return width + gap * Math.max(0, visible.length - 1);
    };
    const fitToolbar = (): void => {
      const style = getComputedStyle(bar);
      const available = bar.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (available <= 0) return;
      for (const group of groups) bar.insertBefore(group.el, more);
      moreMenu!.classList.remove('open');
      more.hidden = true;
      if (contentWidth() <= available) return;
      more.hidden = false;
      const movable = groups.filter((group) => group.priority > 0).sort((a, b) => a.priority - b.priority);
      for (const group of movable) {
        moreMenu!.appendChild(group.el);
        if (contentWidth() <= available) break;
      }
      const overflowed = groups.filter((group) => group.el.parentElement === moreMenu).map((group) => group.el);
      moreMenu!.replaceChildren(...overflowed);
    };
    if (typeof ResizeObserver !== 'undefined') {
      toolbarResizeObserver = new ResizeObserver(() => fitToolbar());
      toolbarResizeObserver.observe(bar);
    }
  } else {
    const pinBtn = document.createElement('button');
    pinBtn.className = 'file-header-btn file-header-pin-btn';
    pinBtn.title = tFileHeader('toolbar.hide');
    pinBtn.setAttribute('aria-label', pinBtn.title);
    pinBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>';
    const syncToolbarPinned = (pinned: boolean): void => {
      document.body.classList.toggle('easyview-toolbar-collapsed', !pinned);
    };
    pinBtn.addEventListener('click', () => {
      writeStoredToolbarPinned(false);
      syncToolbarPinned(false);
    });
    syncToolbarPinned(readStoredToolbarPinned());
    rightGroup.appendChild(pinBtn);
    showToolbarBtn = document.createElement('button');
    showToolbarBtn.type = 'button';
    showToolbarBtn.className = 'file-header-show-toolbar';
    showToolbarBtn.title = tFileHeader('toolbar.show');
    showToolbarBtn.setAttribute('aria-label', showToolbarBtn.title);
    showToolbarBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
    showToolbarBtn.addEventListener('click', () => {
      writeStoredToolbarPinned(true);
      syncToolbarPinned(true);
    });
    document.body.appendChild(showToolbarBtn);
    bar.appendChild(leftGroup);
    bar.appendChild(nameEl);
    bar.appendChild(rightGroup);
  }

  return {
    el: bar,
    getName: () => nameEl.textContent?.trim() || '',
    setName(name: string) { nameEl.textContent = name; },
    setCollapseHandler(handler: () => void) {
      collapseBtn.addEventListener('click', () => {
        allCollapsed = !allCollapsed;
        collapseBtn.title = allCollapsed ? tFileHeader('headings.expand') : tFileHeader('headings.collapse');
        collapseBtn.innerHTML = allCollapsed
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';
        collapseBtn.classList.toggle('active', allCollapsed);
        handler();
      });
    },
    setTocHandler(handler: () => void) {
      tocBtn.addEventListener('click', () => {
        handler();
        onSettingsChange();
      });
    },
    setExportHtmlLightHandler(handler: () => void) {
      exportHtmlLightItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportHtmlDarkHandler(handler: () => void) {
      exportHtmlDarkItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportPdfLightHandler(handler: () => void) {
      exportPdfLightItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportPdfDarkHandler(handler: () => void) {
      exportPdfDarkItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setExportDocxHandler(handler: () => void) {
      exportDocxItem.addEventListener('click', () => {
        exportDropdown.classList.remove('open');
        handler();
      });
    },
    setSourceHandler(handler: () => void) { sourceBtn.addEventListener('click', handler); },
    setScrollTopHandler(handler: () => void) { scrollTopBtn.addEventListener('click', handler); },
    setScrollBottomHandler(handler: () => void) { scrollBottomBtn.addEventListener('click', handler); },
    setStageHandler(handler: () => void) { stageBtn.addEventListener('click', handler); },
    setCommitHandler(handler: () => void) {
      if (capabilities.aiCommitMessage) {
        commitBtn.addEventListener('click', handler);
      }
    },
    setCommitConfirmHandler(handler: (message: string) => void) { commitConfirmHandler = handler; },
    setCommitSyncHandler(handler: (message: string) => void) { commitSyncHandler = handler; },
    setTerminalHandler(handler: () => void) { terminalBtn.addEventListener('click', handler); },
    setHistoryHandler(handler: () => void) { historyBtn.addEventListener('click', handler); },
    setAiChatHandler(handler: () => void) {
      if (capabilities.aiChat) aiChatBtn.addEventListener('click', handler);
    },
    setStickyNoteHandler(handler: () => void) { stickyNoteBtn.addEventListener('click', handler); },
    setExternalFollowHandler(handler: (enabled: boolean) => void) {
      externalFollowHandler = handler;
      externalFollowHandler?.(externalFollowEnabled);
    },
    setViewChangesHandler(handler: () => void) { viewChangesHandler = handler; },
    syncViewChangesState(enabled: boolean, available: boolean) {
      viewChangesEnabled = enabled && available;
      viewChangesAvailable = available;
      viewChangesBtn.disabled = !available;
      viewChangesBtn.setAttribute('aria-disabled', available ? 'false' : 'true');
      viewChangesBtn.classList.toggle('active', viewChangesEnabled);
      setTitleWithShortcut(
        viewChangesBtn,
        !available
          ? tFileHeader('viewChanges.unavailable')
          : viewChangesEnabled ? tFileHeader('viewChanges.exit') : tFileHeader('viewChanges'),
        'toggleViewChanges',
      );
    },
    setShortcutChangeHandler(handler: (config: ToolbarShortcutConfig) => void) {
      shortcutChangeHandler = handler;
      shortcutChangeHandler({ ...shortcutConfig });
    },
    getShortcutConfig() {
      return { ...shortcutConfig };
    },
    syncTocState(visible: boolean) {
      syncTocButton(visible);
    },
    syncFullWidthState(fullWidth: boolean) {
      syncWidthButton(fullWidth);
    },
    syncTableWrapState(enabled: boolean) {
      syncTableWrapButton(enabled);
    },
    syncStickyNoteState(open: boolean) {
      stickyNoteBtn.classList.toggle('active', open);
    },
    syncAiChatState(open: boolean) {
      aiChatBtn.classList.toggle('active', open);
    },
    triggerTocToggle() {
      tocBtn.click();
    },
    triggerWidthToggle() {
      widthBtn.click();
    },
    triggerTableWrapToggle() {
      tableWrapBtn.click();
    },
    triggerExternalFollowToggle() {
      externalFollowBtn.click();
    },
    triggerThemeToggle() {
      themeToggleBtn.click();
    },
    triggerViewChanges() {
      viewChangesBtn.click();
    },
    getThemeState() {
      return { mode: appearance.state.mode, depth: appearance.state.depth };
    },
    cycleTheme() {
      applyThemeMode(nextEasyViewThemeMode(appearance.state.mode), { notifyHost: true });
    },
    setThemeMode(mode: ThemeMode) {
      applyThemeMode(mode, { notifyHost: false });
    },
    setThemeDepth(depth: number) {
      applyThemeDepth(depth);
    },
    getAccentTheme() {
      return appearance.state.accent;
    },
    setAccentTheme(theme: EasyViewAccentTheme) {
      appearance.setAccent(theme);
    },
    openCommitModal,

    closeCommitModal() {
      commitBackdrop.classList.remove('open');
    },
    setCommitMessageLoading(loading: boolean) {
      commitModalBusy = loading;
      commitTextarea.disabled = loading;
      commitSubmitBtn.disabled = true;
      commitSyncBtn.disabled = true;
      commitCancelBtn.disabled = loading;
      commitCloseBtn.disabled = loading;
      commitLoading.classList.toggle('open', loading);
      if (loading) {
        commitTextarea.value = '';
        commitTextarea.placeholder = tFileHeader('commit.generatingPlaceholder');
        commitSource.textContent = '';
        commitSource.classList.remove('visible');
        setCommitStatus('');
      } else {
        commitTextarea.placeholder = tFileHeader('commit.placeholder');
        setCommitStatus('');
        updateCommitSubmitState();
      }
    },
    setCommitMessage(message: string, status = '') {
      commitModalBusy = false;
      commitTextarea.disabled = false;
      commitTextarea.value = message;
      commitTextarea.placeholder = tFileHeader('commit.placeholder');
      commitLoading.classList.remove('open');
      commitSource.textContent = status;
      commitSource.classList.toggle('visible', !!status);
      setCommitStatus('');
      updateCommitSubmitState();
      commitTextarea.focus();
      commitTextarea.select();
    },
    setCommitError(message: string) {
      commitModalBusy = false;
      commitTextarea.disabled = false;
      commitLoading.classList.remove('open');
      commitSource.textContent = '';
      commitSource.classList.remove('visible');
      setCommitStatus(message, true);
      updateCommitSubmitState();
    },
    setCommitInProgress(busy: boolean, mode: 'commit' | 'sync' = 'commit') {
      commitModalBusy = busy;
      commitTextarea.disabled = busy;
      commitSubmitBtn.disabled = busy || !commitTextarea.value.trim();
      commitSyncBtn.disabled = busy || !commitTextarea.value.trim();
      commitCancelBtn.disabled = busy;
      commitCloseBtn.disabled = busy;
      commitLoading.classList.remove('open');
      setCommitStatus(busy ? (mode === 'sync' ? tFileHeader('commit.syncing') : tFileHeader('commit.committing')) : '');
    },
    syncTerminalState(open: boolean) {
      terminalBtn.classList.toggle('active', open);
    },
    getSourceBtn() { return sourceBtn; },
    getHistoryBtn() { return historyBtn; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      appearanceSubscription.unsubscribe();
      toolbarResizeObserver?.disconnect();
      showToolbarBtn?.remove();
      if (depthCloseTimer != null) {
        window.clearTimeout(depthCloseTimer);
        depthCloseTimer = null;
      }
      if (suppressThemeClickTimer != null) {
        window.clearTimeout(suppressThemeClickTimer);
        suppressThemeClickTimer = null;
      }
      depthDragging = false;
      suppressThemeClick = false;
      window.removeEventListener('pointermove', onDepthPointerMove);
      window.removeEventListener('pointerup', onDepthPointerUp);
      window.removeEventListener('pointercancel', onDepthPointerUp);
      dom.root.removeEventListener('wheel', onDocumentWheel as EventListener);
      dom.root.removeEventListener('keydown', onDocumentKeydown as EventListener);
      dom.root.removeEventListener('click', onDocumentClick);
      shortcutsBackdrop.classList.remove('open');
      commitBackdrop.classList.remove('open');
      shortcutsBackdrop.remove();
      commitBackdrop.remove();
      bar.remove();
      shortcutChangeHandler = null;
      externalFollowHandler = null;
      commitConfirmHandler = null;
      commitSyncHandler = null;
    },
  };
}
