/**
 * File Header Bar — top bar with file name, TOC/collapse/width/zoom/source/export controls.
 * Extracted from index.ts as a standalone UI component.
 */

export interface FileHeaderDeps {
  postMessage: (msg: any) => void;
  getState: () => { isFullWidth: boolean; isTocVisible: boolean; isTableWrap: boolean; currentContent: string };
  setState: (patch: Partial<{ isFullWidth: boolean; isTocVisible: boolean; isTableWrap: boolean }>) => void;
  onSettingsChange: () => void;
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
  openSourceMode: 'Open source mode',
  copyOutlinePath: 'Copy outline path',
  copyFullPath: 'Copy file and outline path',
  stageFile: 'Stage current file',
  commitFile: 'Commit current file',
  scrollTop: 'Scroll to top',
  scrollBottom: 'Scroll to bottom',
};

const LINKED_SHORTCUT_ACTIONS: ToolbarShortcutAction[] = ['openWithEasyView', 'openSourceMode'];

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
  // Keep these two actions linked as one shared shortcut.
  const linked = merged.openSourceMode || merged.openWithEasyView;
  if (linked) {
    merged.openSourceMode = linked;
    merged.openWithEasyView = linked;
  }
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
    .file-header-commit-label {
      display: block;
      margin-bottom: 8px;
      font-size: 12px;
      opacity: 0.76;
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
      justify-content: flex-end;
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
  setTerminalHandler: (handler: () => void) => void;
  setHistoryHandler: (handler: () => void) => void;
  setStickyNoteHandler: (handler: () => void) => void;
  setExternalFollowHandler: (handler: (enabled: boolean) => void) => void;
  setShortcutChangeHandler: (handler: (config: ToolbarShortcutConfig) => void) => void;
  getShortcutConfig: () => ToolbarShortcutConfig;
  syncTocState: (visible: boolean) => void;
  syncFullWidthState: (fullWidth: boolean) => void;
  syncTableWrapState: (enabled: boolean) => void;
  syncStickyNoteState: (open: boolean) => void;
  triggerTocToggle: () => void;
  triggerWidthToggle: () => void;
  triggerTableWrapToggle: () => void;
  triggerExternalFollowToggle: () => void;
  triggerThemeToggle: () => void;
  openCommitModal: () => void;
  closeCommitModal: () => void;
  setCommitMessageLoading: (loading: boolean) => void;
  setCommitMessage: (message: string, status?: string) => void;
  setCommitError: (message: string) => void;
  setCommitInProgress: (busy: boolean) => void;
  syncTerminalState: (open: boolean) => void;
  getSourceBtn: () => HTMLElement;
  getHistoryBtn: () => HTMLElement;
}

export function createFileHeader(deps: FileHeaderDeps): FileHeader {
  const { postMessage, getState, setState, onSettingsChange } = deps;
  ensureCommitModalStyles();
  type ThemeMode = 'light' | 'dark';
  type AccentTheme = 'default' | 'blue' | 'orangeRed' | 'green' | 'purple' | 'cherryRed';
  const accentThemes: Array<{ value: AccentTheme; label: string }> = [
    { value: 'default', label: 'Default text' },
    { value: 'blue', label: 'Blue' },
    { value: 'orangeRed', label: 'Orange red' },
    { value: 'green', label: 'Green' },
    { value: 'purple', label: 'Purple' },
    { value: 'cherryRed', label: 'Cherry red' },
  ];

  function readStoredThemeMode(): ThemeMode | null {
    try {
      const stored = localStorage.getItem('mdpre-zalman-theme');
      return stored === 'light' || stored === 'dark' ? stored : null;
    } catch {
      return null;
    }
  }

  function detectThemeMode(): ThemeMode {
    const stored = readStoredThemeMode();
    if (stored) return stored;
    if (document.body.classList.contains('vscode-light')) return 'light';
    if (document.body.classList.contains('vscode-dark')) return 'dark';
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function readStoredAccentTheme(): AccentTheme {
    try {
      const stored = localStorage.getItem('mdpre-zalman-accent-theme') as AccentTheme | null;
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

  const setLinkedShortcut = (action: ToolbarShortcutAction, shortcut: string): void => {
    if (LINKED_SHORTCUT_ACTIONS.includes(action)) {
      for (const linkedAction of LINKED_SHORTCUT_ACTIONS) {
        shortcutConfig[linkedAction] = shortcut;
      }
      return;
    }
    shortcutConfig[action] = shortcut;
  };

  const postCurrentEdit = () => {
    const s = getState();
    postMessage({
      type: 'edit',
      content: s.currentContent,
      fullWidth: s.isFullWidth,
      tocVisible: s.isTocVisible,
      tableWrap: s.isTableWrap,
    });
  };

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
    document.getElementById('editor')?.classList.toggle('full-width', newFullWidth);
    syncWidthButton(newFullWidth);
    postCurrentEdit();
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
    document.getElementById('editor')?.classList.toggle('table-wrap', newTableWrap);
    window.dispatchEvent(new CustomEvent('easyview-table-wrap-layout-change'));
    syncTableWrapButton(newTableWrap);
    postCurrentEdit();
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
    const scrollArea = document.getElementById('editor-scroll-area');
    if (scrollArea) scrollArea.style.fontSize = `${zoomLevel}%`;
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
  document.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      applyZoom(zoomLevel + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }
  }, { passive: false });

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
  stageBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 6.5c-1.1-1.1-2.6-1.7-4.5-1.7-2.8 0-4.8 1.3-4.8 3.5 0 1.9 1.5 2.9 4.4 3.5l1.2.3c2.6.6 3.8 1.4 3.8 3.2 0 2.4-2.1 3.8-5 3.8-2 0-3.7-.6-5-1.8"/></svg>';
  rightGroup.appendChild(stageBtn);

  const commitBtn = document.createElement('button');
  commitBtn.className = 'file-header-btn';
  commitBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M3 12h6"/><path d="M15 12h6"/><path d="M12 3v6"/><path d="M12 15v6"/></svg>';
  rightGroup.appendChild(commitBtn);

  const terminalBtn = document.createElement('button');
  terminalBtn.className = 'file-header-btn';
  terminalBtn.title = 'Open embedded terminal';
  terminalBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/><path d="m7 9 3 3-3 3"/><path d="M12 15h5"/></svg>';
  rightGroup.appendChild(terminalBtn);

  const historyBtn = document.createElement('button');
  historyBtn.className = 'file-header-btn';
  historyBtn.title = 'Toggle history panel';
  historyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  rightGroup.appendChild(historyBtn);

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
  exportDocxItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> Export DOCX';

  exportDropdown.appendChild(exportHtmlLightItem);
  exportDropdown.appendChild(exportHtmlDarkItem);
  exportDropdown.appendChild(exportPdfLightItem);
  exportDropdown.appendChild(exportPdfDarkItem);
  exportDropdown.appendChild(exportDocxItem);
  exportWrapper.appendChild(exportDropdown);
  rightGroup.appendChild(exportWrapper);

  const themeToggleBtn = document.createElement('button');
  themeToggleBtn.className = 'file-header-btn';
  let themeMode: ThemeMode = detectThemeMode();
  function applyThemeMode(mode: ThemeMode) {
    themeMode = mode;
    document.body.classList.toggle('mdpre-light', mode === 'light');
    document.body.classList.toggle('mdpre-dark', mode === 'dark');
    try {
      localStorage.setItem('mdpre-zalman-theme', mode);
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
    themeToggleBtn.classList.toggle('active', mode === 'dark');
    setTitleWithShortcut(themeToggleBtn, mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', 'toggleTheme');
    themeToggleBtn.innerHTML = mode === 'dark'
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 7.5A9 9 0 1 1 12 3Z"/></svg>';
    window.dispatchEvent(new CustomEvent('inlinemd:themeChanged', {
      detail: { mode, isDark: mode === 'dark' },
    }));
  }
  themeToggleBtn.addEventListener('click', () => {
    applyThemeMode(themeMode === 'dark' ? 'light' : 'dark');
  });
  applyThemeMode(themeMode);
  rightGroup.appendChild(themeToggleBtn);

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

  const accentSelect = document.createElement('select');
  accentSelect.className = 'file-header-accent-select';
  accentSelect.title = 'Choose editor text color theme';
  for (const theme of accentThemes) {
    const option = document.createElement('option');
    option.value = theme.value;
    option.textContent = theme.label;
    accentSelect.appendChild(option);
  }
  function applyAccentTheme(theme: AccentTheme) {
    document.body.dataset.mdpreAccent = theme;
    accentSelect.value = theme;
    try {
      localStorage.setItem('mdpre-zalman-accent-theme', theme);
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
  }
  accentSelect.addEventListener('change', () => {
    applyAccentTheme(accentSelect.value as AccentTheme);
  });
  applyAccentTheme(readStoredAccentTheme());
  rightGroup.appendChild(accentSelect);

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
  document.body.appendChild(shortcutsBackdrop);

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
        setLinkedShortcut(action, '');
        input.value = '';
        persistShortcuts();
        return;
      }

      const shortcut = formatEventToShortcut(event);
      if (!shortcut) return;

      setLinkedShortcut(action, shortcut);
      input.value = toDisplayShortcut(shortcut);
      persistShortcuts();
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'file-header-shortcuts-clear';
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      setLinkedShortcut(action, '');
      input.value = '';
      persistShortcuts();
    });

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(clearBtn);
    shortcutsList.appendChild(row);
    shortcutRows.set(action, input);
  };

  (Object.keys(DEFAULT_SHORTCUTS) as ToolbarShortcutAction[]).forEach(createShortcutRow);

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
        <label class="file-header-commit-label">Commit message for current file</label>
        <div class="file-header-commit-input-wrap">
          <span class="file-header-commit-source"></span>
          <textarea class="file-header-commit-textarea" spellcheck="false" placeholder="Generating commit message..."></textarea>
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
      </div>
    </div>
  `;
  document.body.appendChild(commitBackdrop);

  const commitTextarea = commitBackdrop.querySelector('.file-header-commit-textarea') as HTMLTextAreaElement;
  const commitSource = commitBackdrop.querySelector('.file-header-commit-source') as HTMLElement;
  const commitLoading = commitBackdrop.querySelector('.file-header-commit-loading') as HTMLElement;
  const commitStatus = commitBackdrop.querySelector('.file-header-commit-status') as HTMLElement;
  const commitSubmitBtn = commitBackdrop.querySelector('[data-action="commit"]') as HTMLButtonElement;
  const commitCancelBtn = commitBackdrop.querySelector('[data-action="cancel"]') as HTMLButtonElement;
  const commitCloseBtn = commitBackdrop.querySelector('.file-header-commit-close') as HTMLButtonElement;

  const updateCommitSubmitState = (): void => {
    commitSubmitBtn.disabled = !commitTextarea.value.trim() || commitTextarea.disabled;
  };

  const setCommitStatus = (message: string, isError = false): void => {
    commitStatus.textContent = message;
    commitStatus.classList.toggle('error', isError);
  };

  commitTextarea.addEventListener('input', updateCommitSubmitState);
  commitTextarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    commitSubmitBtn.click();
  });
  commitBackdrop.addEventListener('click', (event) => {
    if (event.target === commitBackdrop) {
      commitBackdrop.classList.remove('open');
    }
  });
  commitCancelBtn.addEventListener('click', () => commitBackdrop.classList.remove('open'));
  commitCloseBtn.addEventListener('click', () => commitBackdrop.classList.remove('open'));
  commitSubmitBtn.addEventListener('click', () => {
    const message = commitTextarea.value.trim();
    if (!message || commitSubmitBtn.disabled) return;
    commitConfirmHandler?.(message);
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

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      exportDropdown.classList.remove('open');
      closeShortcutModal();
      commitBackdrop.classList.remove('open');
    }
  });

  // Toggle dropdown on button click
  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
  });

  // Close dropdown on outside click
  document.addEventListener('click', () => {
    exportDropdown.classList.remove('open');
  });

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
    setTitleWithShortcut(sourceBtn, 'Open native source mode with inline suggestions', 'openSourceMode');
    syncExternalFollowButton(externalFollowEnabled);
    setTitleWithShortcut(themeToggleBtn, themeMode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', 'toggleTheme');
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
        postCurrentEdit();
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
    setCommitHandler(handler: () => void) { commitBtn.addEventListener('click', handler); },
    setCommitConfirmHandler(handler: (message: string) => void) { commitConfirmHandler = handler; },
    setTerminalHandler(handler: () => void) { terminalBtn.addEventListener('click', handler); },
    setHistoryHandler(handler: () => void) { historyBtn.addEventListener('click', handler); },
    setStickyNoteHandler(handler: () => void) { stickyNoteBtn.addEventListener('click', handler); },
    setExternalFollowHandler(handler: (enabled: boolean) => void) {
      externalFollowHandler = handler;
      externalFollowHandler?.(externalFollowEnabled);
    },
    setShortcutChangeHandler(handler: (config: ToolbarShortcutConfig) => void) {
      shortcutChangeHandler = handler;
      shortcutChangeHandler?.({ ...shortcutConfig });
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
    openCommitModal() {
      commitBackdrop.classList.add('open');
      commitTextarea.focus();
      commitTextarea.select();
    },
    closeCommitModal() {
      commitBackdrop.classList.remove('open');
    },
    setCommitMessageLoading(loading: boolean) {
      commitTextarea.disabled = loading;
      commitSubmitBtn.disabled = true;
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
      commitTextarea.disabled = false;
      commitLoading.classList.remove('open');
      commitSource.textContent = '';
      commitSource.classList.remove('visible');
      setCommitStatus(message, true);
      updateCommitSubmitState();
    },
    setCommitInProgress(busy: boolean) {
      commitTextarea.disabled = busy;
      commitSubmitBtn.disabled = busy || !commitTextarea.value.trim();
      commitLoading.classList.remove('open');
      setCommitStatus(busy ? 'Committing current file...' : '');
    },
    syncTerminalState(open: boolean) {
      terminalBtn.classList.toggle('active', open);
    },
    getSourceBtn() { return sourceBtn; },
    getHistoryBtn() { return historyBtn; },
  };
}
