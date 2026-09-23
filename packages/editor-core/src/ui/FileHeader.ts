/**
 * File Header Bar — top bar with file name, TOC/collapse/width/zoom/source/export controls.
 * Extracted from index.ts as a standalone UI component.
 */

import type { EditorHostCapabilities } from '@easyview/contracts';
import type { EditorToHostMessage } from '@easyview/contracts/protocol';
import { createEditorDomContext, type EditorDomContext } from '../runtime/editorDomContext';

export interface FileHeaderDeps {
  dom?: EditorDomContext;
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
  | 'copyOutlinePath'
  | 'copyFullPath'
  | 'stageFile'
  | 'commitFile'
  | 'scrollTop'
  | 'scrollBottom';

export type ToolbarShortcutConfig = Record<ToolbarShortcutAction, string>;

const SHORTCUT_STORAGE_KEY = 'mdpre-toolbar-shortcuts';
const EXTERNAL_FOLLOW_STORAGE_KEY = 'mdpre-external-follow-scroll';

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
  copyOutlinePath: 'Alt+Shift+O',
  copyFullPath: 'Alt+Shift+P',
  stageFile: 'Alt+S',
  commitFile: 'Alt+C',
  scrollTop: 'Alt+ArrowUp',
  scrollBottom: 'Alt+ArrowDown',
};

const SHORTCUT_LABELS: Record<ToolbarShortcutAction, string> = {
  openWithEasyView: 'Open with EasyView_Md',
  toggleToc: 'Toggle TOC',
  toggleFullWidth: 'Toggle full width',
  toggleTableWrap: 'Toggle table wrap',
  toggleExternalFollow: 'Toggle external follow scroll',
  toggleTheme: 'Toggle light/dark theme',
  toggleTerminal: 'Toggle embedded terminal',
  toggleStickyNote: 'Toggle sticky note',
  toggleAiChat: 'Toggle AI chat',
  openSourceMode: 'Open source mode',
  copyOutlinePath: 'Copy outline path',
  copyFullPath: 'Copy file and outline path',
  stageFile: 'Stage current file',
  commitFile: 'Commit current file',
  scrollTop: 'Scroll to top',
  scrollBottom: 'Scroll to bottom',
};


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

type ThemeModeName = 'light' | 'gray' | 'dark';
export type EasyViewAccentTheme = 'default' | 'blue' | 'orangeRed' | 'green' | 'purple' | 'cherryRed';
type RgbTuple = [number, number, number];

const THEME_DEPTH_STORAGE_KEY = 'mdpre-zalman-theme-depth';
const THEME_DEPTH_DEFAULT = 0.5;

/** Per-mode bg/fg anchors at depth 0 (top/light), 0.5 (default), 1 (bottom/deep). */
const THEME_DEPTH_AXIS: Record<ThemeModeName, { bg: [string, string, string]; fg: [string, string, string] }> = {
  light: {
    bg: ['#ffffff', '#ffffff', '#8b929e'],
    fg: ['#050608', '#1f2328', '#f3f5f7'],
  },
  gray: {
    bg: ['#e4e7ec', '#b0b6c0', '#5c6470'],
    fg: ['#020304', '#050608', '#f5f6f8'],
  },
  dark: {
    bg: ['#3c3c3c', '#1e1e1e', '#0a0a0a'],
    fg: ['#9a9a9a', '#d4d4d4', '#ffffff'],
  },
};

function parseHexColor(hex: string): RgbTuple {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: RgbTuple): string {
  return `#${[r, g, b]
    .map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function lerpRgb(a: RgbTuple, b: RgbTuple, t: number): RgbTuple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function lerpHex(a: string, b: string, t: number): string {
  return rgbToHex(lerpRgb(parseHexColor(a), parseHexColor(b), t));
}

function axisLerp(low: string, mid: string, high: string, depth: number): string {
  if (depth <= 0.5) return lerpHex(low, mid, depth / 0.5);
  return lerpHex(mid, high, (depth - 0.5) / 0.5);
}

function mixHex(a: string, b: string, amountTowardB: number): string {
  return lerpHex(a, b, amountTowardB);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function readStoredThemeDepth(): number {
  try {
    const raw = localStorage.getItem(THEME_DEPTH_STORAGE_KEY);
    if (raw == null) return THEME_DEPTH_DEFAULT;
    const value = Number(raw);
    return Number.isFinite(value) ? clamp01(value) : THEME_DEPTH_DEFAULT;
  } catch {
    return THEME_DEPTH_DEFAULT;
  }
}

function writeStoredThemeDepth(depth: number): void {
  try {
    localStorage.setItem(THEME_DEPTH_STORAGE_KEY, String(clamp01(depth)));
  } catch {
    // Webview storage can be unavailable in restricted contexts.
  }
}

function applyThemeDepthColors(mode: ThemeModeName, depth: number, themeRoot: HTMLElement): void {
  const axis = THEME_DEPTH_AXIS[mode];
  const t = clamp01(depth);
  const bg = axisLerp(axis.bg[0], axis.bg[1], axis.bg[2], t);
  const fg = axisLerp(axis.fg[0], axis.fg[1], axis.fg[2], t);
  const widget = mixHex(bg, fg, 0.1);
  const input = mixHex(bg, fg, 0.06);
  const border = mixHex(bg, fg, 0.28);
  const desc = mixHex(fg, bg, 0.38);
  const icon = mixHex(fg, bg, 0.22);
  const selection = mixHex(bg, fg, 0.18);
  const hover = mixHex(bg, fg, 0.12);
  const body = themeRoot;
  body.style.setProperty('--vscode-editor-background', bg);
  body.style.setProperty('--vscode-editor-foreground', fg);
  body.style.setProperty('--vscode-foreground', fg);
  body.style.setProperty('--vscode-icon-foreground', icon);
  body.style.setProperty('--vscode-descriptionForeground', desc);
  body.style.setProperty('--vscode-input-background', input);
  body.style.setProperty('--vscode-input-foreground', fg);
  body.style.setProperty('--vscode-input-border', border);
  body.style.setProperty('--vscode-input-placeholderForeground', mixHex(desc, bg, 0.15));
  body.style.setProperty('--vscode-editorWidget-background', widget);
  body.style.setProperty('--vscode-editorWidget-foreground', fg);
  body.style.setProperty('--vscode-editorWidget-border', border);
  body.style.setProperty('--vscode-menu-background', input);
  body.style.setProperty('--vscode-menu-foreground', fg);
  body.style.setProperty('--vscode-menu-border', border);
  body.style.setProperty('--vscode-menu-selectionBackground', selection);
  body.style.setProperty('--vscode-menu-selectionForeground', fg);
  body.style.setProperty('--vscode-list-hoverBackground', hover);
  body.style.setProperty('--vscode-list-activeSelectionBackground', mixHex(bg, '#0969da', 0.35));
  body.style.setProperty('--vscode-list-activeSelectionForeground', fg);
  body.style.setProperty('--vscode-textCodeBlock-background', mixHex(bg, fg, 0.1));
  body.style.setProperty('--vscode-textBlockQuote-border', border);
  body.style.setProperty('--vscode-textBlockQuote-background', widget);
  body.style.setProperty('--vscode-dropdown-background', input);
  body.style.setProperty('--vscode-dropdown-foreground', fg);
  body.style.setProperty('--vscode-dropdown-border', border);
  body.style.setProperty('--vscode-toolbar-hoverBackground', mixHex(bg, fg, 0.1));
  body.style.setProperty('--vscode-scrollbarSlider-background', mixHex(fg, bg, 0.55) + '66');
  body.style.setProperty('--vscode-scrollbarSlider-hoverBackground', mixHex(fg, bg, 0.45) + '99');
  body.style.setProperty('--vscode-scrollbarSlider-activeBackground', mixHex(fg, bg, 0.35) + 'b3');
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
  type ThemeMode = 'light' | 'gray' | 'dark';
  const THEME_CYCLE: ThemeMode[] = ['light', 'gray', 'dark'];
  const accentThemes: Array<{ value: EasyViewAccentTheme; label: string }> = [
    { value: 'default', label: 'Default text' },
    { value: 'blue', label: 'Blue' },
    { value: 'orangeRed', label: 'Orange red' },
    { value: 'green', label: 'Green' },
    { value: 'purple', label: 'Purple' },
    { value: 'cherryRed', label: 'Cherry red' },
  ];

  function readStoredThemeMode(): ThemeMode | null {
    try {
      const primary = localStorage.getItem('easyview.themeMode');
      if (primary === 'light' || primary === 'gray' || primary === 'dark') return primary;
      const stored = localStorage.getItem('mdpre-zalman-theme');
      return stored === 'light' || stored === 'gray' || stored === 'dark' ? stored : null;
    } catch {
      return null;
    }
  }

  function nextThemeMode(current: ThemeMode): ThemeMode {
    const index = THEME_CYCLE.indexOf(current);
    return THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
  }

  function detectThemeMode(): ThemeMode {
    const stored = readStoredThemeMode();
    if (stored) return stored;
    if (dom.themeRoot.classList.contains('vscode-light')) return 'light';
    if (dom.themeRoot.classList.contains('vscode-dark')) return 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function readStoredAccentTheme(): EasyViewAccentTheme {
    try {
      const stored = localStorage.getItem('mdpre-zalman-accent-theme') as EasyViewAccentTheme | null;
      if (accentThemes.some((theme) => theme.value === stored)) return stored!;
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
    return 'default';
  }

  const bar = document.createElement('div');
  bar.className = 'file-header-bar';

  let shortcutConfig = readStoredShortcuts();
  let shortcutChangeHandler: ((config: ToolbarShortcutConfig) => void) | null = null;
  let externalFollowEnabled = readStoredExternalFollowEnabled();
  let externalFollowHandler: ((enabled: boolean) => void) | null = null;
  let commitConfirmHandler: ((message: string) => void) | null = null;
  let commitSyncHandler: ((message: string) => void) | null = null;
  let commitModalBusy = false;



  const nameEl = document.createElement('span');
  nameEl.className = 'file-header-name';
  nameEl.contentEditable = 'true';
  nameEl.spellcheck = false;
  nameEl.title = 'Click to rename';

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
    return value ? toDisplayShortcut(value) : 'Unassigned';
  };

  const setTitleWithShortcut = (element: HTMLElement, text: string, action?: ToolbarShortcutAction): void => {
    element.title = action ? `${text} (${shortcutLabel(action)})` : text;
  };

  const syncTocButton = (visible: boolean): void => {
    tocBtn.classList.toggle('active', visible);
    setTitleWithShortcut(tocBtn, visible ? 'Hide Table of Contents' : 'Toggle Table of Contents', 'toggleToc');
  };

  const syncWidthButton = (fullWidth: boolean): void => {
    widthBtn.classList.toggle('active', fullWidth);
    widthBtn.innerHTML = fullWidth
      ? '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M4 14h6v6\"/><path d=\"M20 10h-6V4\"/><path d=\"M14 10l7-7\"/><path d=\"M3 21l7-7\"/></svg>'
      : '<svg width=\"16\" height=\"16\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"><path d=\"M15 3h6v6\"/><path d=\"M9 21H3v-6\"/><path d=\"M21 3l-7 7\"/><path d=\"M3 21l7-7\"/></svg>';
    setTitleWithShortcut(widthBtn, fullWidth ? 'Exit full width' : 'Expand to full width', 'toggleFullWidth');
  };

  const syncTableWrapButton = (enabled: boolean): void => {
    tableWrapBtn.classList.toggle('active', enabled);
    setTitleWithShortcut(tableWrapBtn, enabled ? 'Disable table word wrap' : 'Enable table word wrap', 'toggleTableWrap');
  };

  const syncExternalFollowButton = (enabled: boolean): void => {
    externalFollowBtn.classList.toggle('active', enabled);
    setTitleWithShortcut(
      externalFollowBtn,
      enabled ? 'Disable external-edit auto-follow scroll' : 'Enable external-edit auto-follow scroll',
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
  collapseBtn.title = 'Collapse all headings';
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
  zoomOutBtn.title = 'Zoom out';
  zoomOutBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  const zoomLabel = document.createElement('span');
  zoomLabel.className = 'file-header-zoom-label';
  zoomLabel.textContent = '100%';
  zoomLabel.title = 'Click to reset zoom';
  const zoomInBtn = document.createElement('button');
  zoomInBtn.className = 'file-header-btn file-header-zoom-btn';
  zoomInBtn.title = 'Zoom in';
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
  terminalBtn.title = 'Open embedded terminal';
  terminalBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="m7 9 3 3-3 3"/><path d="M12 15h5"/></svg>';
  if (capabilities.terminal) rightGroup.appendChild(terminalBtn);

  const historyBtn = document.createElement('button');
  historyBtn.className = 'file-header-btn';
  historyBtn.title = 'Toggle history panel';
  historyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  rightGroup.appendChild(historyBtn);

  const aiChatBtn = document.createElement('button');
  aiChatBtn.className = 'file-header-btn';
  aiChatBtn.title = 'Toggle AI chat';
  aiChatBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  if (capabilities.aiChat) rightGroup.appendChild(aiChatBtn);

  const stickyNoteBtn = document.createElement('button');
  stickyNoteBtn.className = 'file-header-btn';
  stickyNoteBtn.title = 'Toggle sticky note editor';
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
  exportBtn.title = 'Export';
  exportBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  exportWrapper.appendChild(exportBtn);

  const exportDropdown = document.createElement('div');
  exportDropdown.className = 'file-header-dropdown';

  const exportHtmlLightItem = document.createElement('button');
  exportHtmlLightItem.className = 'file-header-dropdown-item';
  exportHtmlLightItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Export HTML (Light)';

  const exportHtmlDarkItem = document.createElement('button');
  exportHtmlDarkItem.className = 'file-header-dropdown-item';
  exportHtmlDarkItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg> Export HTML (Dark)';

  const exportPdfLightItem = document.createElement('button');
  exportPdfLightItem.className = 'file-header-dropdown-item';
  exportPdfLightItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Export PDF (Light)';

  const exportPdfDarkItem = document.createElement('button');
  exportPdfDarkItem.className = 'file-header-dropdown-item';
  exportPdfDarkItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Export PDF (Dark)';

  const exportDocxItem = document.createElement('button');
  exportDocxItem.className = 'file-header-dropdown-item';
  exportDocxItem.dataset.action = 'exportDocx';
  exportDocxItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Export DOCX';

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
  let themeMode: ThemeMode = detectThemeMode();
  let themeDepth = readStoredThemeDepth();
  let accentThemeUiSync: (() => void) | null = null;
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
    light: 'Light mode (click to switch)',
    gray: 'Gray mode (click to switch)',
    dark: 'Dark mode (click to switch)',
  };

  const depthPanel = document.createElement('div');
  depthPanel.className = 'file-header-theme-depth';
  depthPanel.title = 'Drag to adjust background depth';
  const depthTrack = document.createElement('div');
  depthTrack.className = 'file-header-theme-depth-track';
  const depthThumb = document.createElement('div');
  depthThumb.className = 'file-header-theme-depth-thumb';
  depthTrack.appendChild(depthThumb);
  depthPanel.appendChild(depthTrack);

  function syncDepthThumb(): void {
    depthThumb.style.top = `${themeDepth * 100}%`;
  }

  function applyThemeDepth(depth: number, persist = true): void {
    themeDepth = clamp01(depth);
    applyThemeDepthColors(themeMode, themeDepth, dom.themeRoot);
    syncDepthThumb();
    if (persist) writeStoredThemeDepth(themeDepth);
  }

  function applyThemeMode(mode: ThemeMode, options?: { notifyHost?: boolean }) {
    themeMode = mode;
    dom.themeRoot.classList.toggle('mdpre-light', mode === 'light');
    dom.themeRoot.classList.toggle('mdpre-gray', mode === 'gray');
    dom.themeRoot.classList.toggle('mdpre-dark', mode === 'dark');
    const stampRoots: Array<HTMLElement | null> = [
      document.documentElement,
      dom.themeRoot,
      document.getElementById('desktop-root'),
    ];
    for (const root of stampRoots) {
      if (root) root.dataset.easyviewTheme = mode;
    }
    try {
      localStorage.setItem('easyview.themeMode', mode);
      localStorage.setItem('mdpre-zalman-theme', mode);
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
    themeToggleBtn.classList.toggle('active', mode !== 'light');
    setTitleWithShortcut(themeToggleBtn, THEME_TITLES[mode], 'toggleTheme');
    themeToggleBtn.innerHTML = THEME_ICONS[mode];
    applyThemeDepth(themeDepth, false);
    const detail = { mode, isDark: mode === 'dark', depth: themeDepth };
    dom.eventTarget.dispatchEvent(new CustomEvent('inlinemd:themeChanged', { detail }));
    window.dispatchEvent(new CustomEvent('easyview:productThemeChanged', { detail }));
    if (options?.notifyHost !== false) {
      postMessage({ type: 'productThemeChanged', mode });
    }
    accentThemeUiSync?.();
  }

  function depthFromClientY(clientY: number): number {
    const rect = depthTrack.getBoundingClientRect();
    if (rect.height <= 0) return themeDepth;
    return clamp01((clientY - rect.top) / rect.height);
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
    applyThemeMode(nextThemeMode(themeMode), { notifyHost: true });
  });
  applyThemeMode(themeMode, { notifyHost: false });
  syncDepthThumb();
  themeWrap.appendChild(themeToggleBtn);
  themeWrap.appendChild(depthPanel);
  rightGroup.appendChild(themeWrap);

  const externalFollowBtn = document.createElement('button');
  externalFollowBtn.className = 'file-header-btn';
  externalFollowBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 18 6-6-6-6"/><circle cx="6" cy="12" r="2"/></svg>';
  externalFollowBtn.addEventListener('click', () => {
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
  accentSelect.title = 'Choose editor text color theme';
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
    return accentThemeColors[theme][themeMode];
  }
  function applyAccentTheme(theme: EasyViewAccentTheme) {
    dom.themeRoot.dataset.mdpreAccent = theme;
    const selected = accentThemes.find((item) => item.value === theme) ?? accentThemes[0];
    accentLabel.textContent = selected.label;
    accentSelect.style.color = accentOptionColor(theme);
    for (const item of accentThemes) {
      const optionEl = accentOptionEls.get(item.value);
      if (!optionEl) continue;
      optionEl.classList.toggle('active', item.value === theme);
      optionEl.style.color = accentOptionColor(item.value);
    }
    try {
      localStorage.setItem('mdpre-zalman-accent-theme', theme);
    } catch {
      // Webview storage can be unavailable in restricted contexts.
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
      applyAccentTheme(theme.value);
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
  accentThemeUiSync = () => {
    applyAccentTheme((dom.themeRoot.dataset.mdpreAccent as EasyViewAccentTheme) || readStoredAccentTheme());
  };
  applyAccentTheme(readStoredAccentTheme());
  accentWrap.appendChild(accentSelect);
  accentWrap.appendChild(accentMenu);
  rightGroup.appendChild(accentWrap);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'file-header-btn';
  settingsBtn.title = 'Configure toolbar shortcuts';
  settingsBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.5.2 1.06 0 1.56.5.2 1.06.2 1.56 0H21a2 2 0 1 1 0 4h-.09c-.45 0-.88.18-1.2.44z"/></svg>';
  rightGroup.appendChild(settingsBtn);

  const shortcutsBackdrop = document.createElement('div');
  shortcutsBackdrop.className = 'file-header-shortcuts-backdrop';
  shortcutsBackdrop.innerHTML = `
    <div class="file-header-shortcuts-modal" role="dialog" aria-modal="true" aria-label="Toolbar shortcuts">
      <div class="file-header-shortcuts-title">Toolbar Shortcut Settings</div>
      <div class="file-header-shortcuts-list"></div>
      <div class="file-header-shortcuts-actions">
        <button class="file-header-shortcuts-btn" data-action="reset">Restore Defaults</button>
        <button class="file-header-shortcuts-btn primary" data-action="close">Done</button>
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
    label.textContent = SHORTCUT_LABELS[action];

    const input = document.createElement('input');
    input.className = 'file-header-shortcuts-input';
    input.type = 'text';
    input.readOnly = true;
    input.value = shortcutConfig[action] ? toDisplayShortcut(shortcutConfig[action]) : '';
    input.placeholder = 'Press shortcut';
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
    clearBtn.textContent = 'Clear';
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
    <div class="file-header-commit-modal" role="dialog" aria-modal="true" aria-label="Commit">
      <div class="file-header-commit-title">
        <span>Commit</span>
        <button class="file-header-commit-close" type="button" aria-label="Close">x</button>
      </div>
      <div class="file-header-commit-body">
        <div class="file-header-commit-input-wrap">
          <span class="file-header-commit-source"></span>
          <textarea class="file-header-commit-textarea" spellcheck="false" placeholder="Commit message"></textarea>
          <div class="file-header-commit-loading" aria-live="polite">
            <span class="file-header-commit-spinner"></span>
            <span>Generating message<span class="file-header-commit-loading-dots"></span></span>
          </div>
        </div>
        <div class="file-header-commit-status"></div>
      </div>
      <div class="file-header-commit-actions">
        <button class="file-header-commit-btn" type="button" data-action="cancel">Cancel</button>
        <button class="file-header-commit-btn primary" type="button" data-action="commit">Commit</button>
        <button class="file-header-commit-btn sync" type="button" data-action="sync">Sync</button>
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
      commitTextarea.placeholder = 'Commit message';
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
    exportDropdown.classList.remove('open');
    accentMenu.classList.remove('open');
  };
  dom.root.addEventListener('click', onDocumentClick);

  const refreshShortcutAwareTitles = (): void => {
    const state = getState();
    syncTocButton(state.isTocVisible);
    syncWidthButton(state.isFullWidth);
    syncTableWrapButton(state.isTableWrap);
    setTitleWithShortcut(scrollTopBtn, 'Scroll to top', 'scrollTop');
    setTitleWithShortcut(scrollBottomBtn, 'Scroll to bottom', 'scrollBottom');
    setTitleWithShortcut(stageBtn, 'Stage current file', 'stageFile');
    setTitleWithShortcut(commitBtn, 'Commit current file', 'commitFile');
    setTitleWithShortcut(terminalBtn, 'Open embedded terminal', 'toggleTerminal');
    setTitleWithShortcut(stickyNoteBtn, 'Toggle sticky note editor', 'toggleStickyNote');
    setTitleWithShortcut(aiChatBtn, 'Toggle AI chat', 'toggleAiChat');
    setTitleWithShortcut(
      sourceBtn,
      capabilities.sourceMode === 'native' ? 'Open native source mode' : 'Toggle source mode',
      'openSourceMode',
    );
    syncExternalFollowButton(externalFollowEnabled);
    setTitleWithShortcut(themeToggleBtn, THEME_TITLES[themeMode], 'toggleTheme');
  };

  refreshShortcutAwareTitles();

  bar.appendChild(leftGroup);
  bar.appendChild(nameEl);
  bar.appendChild(rightGroup);

  return {
    el: bar,
    setName(name: string) { nameEl.textContent = name; },
    setCollapseHandler(handler: () => void) {
      collapseBtn.addEventListener('click', () => {
        allCollapsed = !allCollapsed;
        collapseBtn.title = allCollapsed ? 'Expand all headings' : 'Collapse all headings';
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
        const state = getState();
        const newTocVisible = !state.isTocVisible;
        setState({ isTocVisible: newTocVisible });
        syncTocButton(newTocVisible);
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
    getThemeState() {
      return { mode: themeMode, depth: themeDepth };
    },
    cycleTheme() {
      applyThemeMode(nextThemeMode(themeMode), { notifyHost: true });
    },
    setThemeMode(mode: ThemeMode) {
      applyThemeMode(mode, { notifyHost: false });
    },
    setThemeDepth(depth: number) {
      applyThemeDepth(depth);
    },
    getAccentTheme() {
      return (dom.themeRoot.dataset.mdpreAccent as EasyViewAccentTheme) || readStoredAccentTheme();
    },
    setAccentTheme(theme: EasyViewAccentTheme) {
      applyAccentTheme(theme);
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
        commitTextarea.placeholder = 'Generating commit message...';
        commitSource.textContent = '';
        commitSource.classList.remove('visible');
        setCommitStatus('');
      } else {
        commitTextarea.placeholder = 'Commit message';
        setCommitStatus('');
        updateCommitSubmitState();
      }
    },
    setCommitMessage(message: string, status = '') {
      commitModalBusy = false;
      commitTextarea.disabled = false;
      commitTextarea.value = message;
      commitTextarea.placeholder = 'Commit message';
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
      setCommitStatus(busy ? (mode === 'sync' ? 'Syncing current file...' : 'Committing current file...') : '');
    },
    syncTerminalState(open: boolean) {
      terminalBtn.classList.toggle('active', open);
    },
    getSourceBtn() { return sourceBtn; },
    getHistoryBtn() { return historyBtn; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
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
