import { createSourceEditor } from '../editor/SourceEditor';

interface TabCompletionRequest {
  line: number;
  character: number;
  wordPrefix: string;
}

type StickyNoteMode = 'localFile' | 'tempFile';
type StickyNoteDisplayMode = 'sourceNative' | 'renderDisplay';

interface StickyNoteModalOptions {
  getDocumentContent: () => string;
  commitDocumentContent: (content: string, options?: { save: boolean }) => void;
  requestTabCompletion?: (request: TabCompletionRequest) => Promise<{
    insertText: string;
    replaceStartCharacter?: number;
    replaceEndCharacter?: number;
  } | null>;
  onVisibilityChange?: (visible: boolean) => void;
}

interface StickyRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface StickyNoteModal {
  open: () => void;
  close: () => void;
  toggle: () => void;
  setDocumentContent: (content: string) => void;
  isOpen: () => boolean;
  destroy: () => void;
}

const PANEL_MIN_WIDTH = 360;
const PANEL_MIN_HEIGHT = 240;
const PANEL_DEFAULT_WIDTH = 520;
const PANEL_DEFAULT_HEIGHT = 380;
const PANEL_MARGIN = 16;
const PANEL_TOP_OFFSET = 72;
const STICKY_NOTE_TEMP_CONTENT_KEY = 'easyview-md-sticky-note-temp-content';
const STICKY_NOTE_RECT_KEY = 'easyview-md-sticky-note-rect';
const STICKY_NOTE_RECT_VERSION_KEY = 'easyview-md-sticky-note-rect-version';
const STICKY_NOTE_RECT_VERSION = '2';
const STICKY_NOTE_MODE_KEY = 'easyview-md-sticky-note-mode';
const STICKY_NOTE_DISPLAY_MODE_KEY = 'easyview-md-sticky-note-display-mode';
const STICKY_NOTE_FONT_SIZE_KEY = 'easyview-md-sticky-note-font-size';
const LOCAL_FILE_SAVE_DEBOUNCE_MS = 300;
const STICKY_NOTE_FONT_SIZE_MIN = 11;
const STICKY_NOTE_FONT_SIZE_MAX = 22;
const STICKY_NOTE_FONT_SIZE_DEFAULT = 13;

export function createStickyNoteModal(options: StickyNoteModalOptions): StickyNoteModal {
  ensureStickyNoteStyles();

  const root = document.createElement('div');
  root.className = 'easyview-sticky-note';

  const header = document.createElement('div');
  header.className = 'easyview-sticky-note__header';

  const title = document.createElement('div');
  title.className = 'easyview-sticky-note__title';
  title.textContent = '小签';

  const headerCenter = document.createElement('div');
  headerCenter.className = 'easyview-sticky-note__center';

  const modeGroup = document.createElement('div');
  modeGroup.className = 'easyview-sticky-note__mode-group';

  const headerActions = document.createElement('div');
  headerActions.className = 'easyview-sticky-note__actions';

  const displayModeWrap = document.createElement('div');
  displayModeWrap.className = 'easyview-sticky-note__display-mode';

  const nativeModeLabel = document.createElement('span');
  nativeModeLabel.className = 'easyview-sticky-note__display-label';
  nativeModeLabel.textContent = '原生';

  const displayToggleBtn = document.createElement('button');
  displayToggleBtn.type = 'button';
  displayToggleBtn.className = 'easyview-sticky-note__display-toggle';
  displayToggleBtn.setAttribute('aria-label', '切换小签显示模式');
  displayToggleBtn.title = '左侧为原生 VS Code 编辑器模式，右侧为渲染显示模式';
  displayToggleBtn.innerHTML = '<span class="easyview-sticky-note__display-thumb"></span>';

  const renderModeLabel = document.createElement('span');
  renderModeLabel.className = 'easyview-sticky-note__display-label';
  renderModeLabel.textContent = '渲染';

  const localModeBtn = document.createElement('button');
  localModeBtn.type = 'button';
  localModeBtn.className = 'easyview-sticky-note__mode-btn';
  localModeBtn.textContent = '本地文件';
  localModeBtn.title = '读取当前文件内容，关闭后自动保存回当前文件';

  const tempModeBtn = document.createElement('button');
  tempModeBtn.type = 'button';
  tempModeBtn.className = 'easyview-sticky-note__mode-btn';
  tempModeBtn.textContent = '临时文件';
  tempModeBtn.title = '独立临时内容，仅保存在本地存储';

  modeGroup.appendChild(tempModeBtn);
  modeGroup.appendChild(localModeBtn);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'easyview-sticky-note__close';
  closeBtn.setAttribute('aria-label', 'Close sticky note');
  closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

  const decreaseFontBtn = document.createElement('button');
  decreaseFontBtn.type = 'button';
  decreaseFontBtn.className = 'easyview-sticky-note__action-btn';
  decreaseFontBtn.setAttribute('aria-label', 'Decrease sticky note font size');
  decreaseFontBtn.title = '缩小字号';
  decreaseFontBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>';

  const increaseFontBtn = document.createElement('button');
  increaseFontBtn.type = 'button';
  increaseFontBtn.className = 'easyview-sticky-note__action-btn';
  increaseFontBtn.setAttribute('aria-label', 'Increase sticky note font size');
  increaseFontBtn.title = '放大字号';
  increaseFontBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';

  const body = document.createElement('div');
  body.className = 'easyview-sticky-note__body';

  const editorMount = document.createElement('div');
  editorMount.className = 'easyview-sticky-note__editor';
  body.appendChild(editorMount);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'easyview-sticky-note__resize';
  resizeHandle.setAttribute('aria-hidden', 'true');

  header.appendChild(title);
  displayModeWrap.appendChild(nativeModeLabel);
  displayModeWrap.appendChild(displayToggleBtn);
  displayModeWrap.appendChild(renderModeLabel);
  headerCenter.appendChild(modeGroup);
  headerCenter.appendChild(displayModeWrap);
  header.appendChild(headerCenter);
  headerActions.appendChild(decreaseFontBtn);
  headerActions.appendChild(increaseFontBtn);
  headerActions.appendChild(closeBtn);
  header.appendChild(headerActions);
  root.appendChild(header);
  root.appendChild(body);
  root.appendChild(resizeHandle);
  document.body.appendChild(root);

  let suppressChange = false;
  let open = false;
  let rect = readStoredRect() ?? createDefaultRect();
  let mode: StickyNoteMode = readStoredMode();
  let displayMode: StickyNoteDisplayMode = readStoredDisplayMode();
  let latestDocumentContent = '';
  let localFileDraft = '';
  let localFileDirty = false;
  let tempContent = readStoredTempContent();
  let fontSize = readStoredFontSize();
  let localFileSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let editor: ReturnType<typeof createSourceEditor> | null = null;

  const syncDisplayModeToggle = (): void => {
    const renderDisplay = displayMode === 'renderDisplay';
    displayToggleBtn.classList.toggle('render-display', renderDisplay);
    nativeModeLabel.classList.toggle('active', !renderDisplay);
    renderModeLabel.classList.toggle('active', renderDisplay);
  };

  const persistDisplayMode = (): void => {
    try {
      localStorage.setItem(STICKY_NOTE_DISPLAY_MODE_KEY, displayMode);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  };

  const applyFontSize = (persist = false): void => {
    const next = Math.max(STICKY_NOTE_FONT_SIZE_MIN, Math.min(STICKY_NOTE_FONT_SIZE_MAX, fontSize));
    fontSize = next;
    root.style.setProperty('--easyview-sticky-note-font-size', `${fontSize}px`);
    decreaseFontBtn.disabled = fontSize <= STICKY_NOTE_FONT_SIZE_MIN;
    increaseFontBtn.disabled = fontSize >= STICKY_NOTE_FONT_SIZE_MAX;
    editor?.view.requestMeasure();
    if (persist) persistFontSize(fontSize);
  };

  const clearLocalFileSaveTimer = (): void => {
    if (!localFileSaveTimer) return;
    clearTimeout(localFileSaveTimer);
    localFileSaveTimer = null;
  };

  const scheduleLocalFileSave = (): void => {
    clearLocalFileSaveTimer();
    localFileSaveTimer = setTimeout(() => {
      localFileSaveTimer = null;
      options.commitDocumentContent(localFileDraft, { save: true });
    }, LOCAL_FILE_SAVE_DEBOUNCE_MS);
  };

  const createEditorInstance = (): ReturnType<typeof createSourceEditor> => {
    editor = createSourceEditor({
      parent: editorMount,
      visualMode: displayMode === 'renderDisplay' ? 'stickyNoteCompactMarkdown' : 'default',
      onChange: (content) => {
        if (suppressChange) return;
        if (mode === 'tempFile') {
          tempContent = content;
          persistTempContent(content);
          return;
        }
        localFileDraft = content;
        localFileDirty = content !== latestDocumentContent;
        if (!localFileDirty) {
          clearLocalFileSaveTimer();
          return;
        }
        latestDocumentContent = content;
        localFileDirty = false;
        options.commitDocumentContent(content, { save: false });
        scheduleLocalFileSave();
      },
      requestTabCompletion: options.requestTabCompletion,
    });
    return editor;
  };

  const ensureEditor = (): ReturnType<typeof createSourceEditor> => {
    if (editor) return editor;
    return createEditorInstance();
  };

  const rebuildEditor = (focus = true): void => {
    const content = editor?.getContent() ?? (mode === 'localFile' ? localFileDraft : tempContent);
    editor?.destroy();
    editor = null;
    editorMount.replaceChildren();
    const activeEditor = createEditorInstance();
    suppressChange = true;
    activeEditor.setContent(content);
    suppressChange = false;
    applyFontSize(false);
    if (focus && open) {
      requestAnimationFrame(() => {
        activeEditor.view.requestMeasure();
        activeEditor.focus();
      });
    }
  };

  const setEditorContent = (content: string): void => {
    const activeEditor = ensureEditor();
    if (activeEditor.getContent() === content) return;
    suppressChange = true;
    activeEditor.setContent(content);
    suppressChange = false;
  };

  const syncModeButtons = (): void => {
    localModeBtn.classList.toggle('active', mode === 'localFile');
    tempModeBtn.classList.toggle('active', mode === 'tempFile');
  };

  const persistMode = (): void => {
    try {
      localStorage.setItem(STICKY_NOTE_MODE_KEY, mode);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  };

  const applyRect = (persist = false): void => {
    rect = clampRect(rect);
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
    if (persist) persistRect(rect);
    editor?.view.requestMeasure();
  };

  const handleWindowResize = (): void => {
    applyRect();
  };

  const commitLocalFileDraft = (): void => {
    if (!localFileDirty) {
      clearLocalFileSaveTimer();
      return;
    }
    clearLocalFileSaveTimer();
    latestDocumentContent = localFileDraft;
    localFileDirty = false;
    options.commitDocumentContent(localFileDraft, { save: true });
  };

  const loadModeContent = (nextMode: StickyNoteMode): void => {
    if (nextMode === 'localFile') {
      latestDocumentContent = options.getDocumentContent();
      localFileDraft = latestDocumentContent;
      localFileDirty = false;
      setEditorContent(localFileDraft);
      return;
    }
    tempContent = readStoredTempContent();
    setEditorContent(tempContent);
  };

  const switchMode = (nextMode: StickyNoteMode): void => {
    if (mode === nextMode) return;
    if (mode === 'localFile') {
      commitLocalFileDraft();
    } else {
      tempContent = editor?.getContent() ?? tempContent;
      persistTempContent(tempContent);
    }
    mode = nextMode;
    persistMode();
    syncModeButtons();
    loadModeContent(nextMode);
    requestAnimationFrame(() => editor?.focus());
  };

  const switchDisplayMode = (nextMode: StickyNoteDisplayMode): void => {
    if (displayMode === nextMode) return;
    if (mode === 'tempFile') {
      tempContent = editor?.getContent() ?? tempContent;
      persistTempContent(tempContent);
    } else {
      localFileDraft = editor?.getContent() ?? localFileDraft;
    }
    displayMode = nextMode;
    persistDisplayMode();
    syncDisplayModeToggle();
    rebuildEditor(true);
  };

  const setOpen = (visible: boolean): void => {
    if (!visible && mode === 'localFile') {
      commitLocalFileDraft();
    }
    if (!visible && open) {
      persistRect(rect);
    }
    open = visible;
    root.classList.toggle('open', visible);
    options.onVisibilityChange?.(visible);
    if (!visible) return;

    ensureEditor();
    loadModeContent(mode);
    applyRect();
    requestAnimationFrame(() => {
      editor?.view.requestMeasure();
      editor?.focus();
    });
  };

  const beginDrag = (event: PointerEvent): void => {
    if ((event.target as HTMLElement).closest('button')) return;
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;

    const move = (moveEvent: PointerEvent) => {
      rect.left = startLeft + (moveEvent.clientX - startX);
      rect.top = startTop + (moveEvent.clientY - startY);
      applyRect();
    };
    const end = () => {
      persistRect(rect);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  };

  const beginResize = (event: PointerEvent): void => {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = rect.width;
    const startHeight = rect.height;

    const move = (moveEvent: PointerEvent) => {
      rect.width = startWidth + (moveEvent.clientX - startX);
      rect.height = startHeight + (moveEvent.clientY - startY);
      applyRect();
    };
    const end = () => {
      persistRect(rect);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end, { once: true });
  };

  localModeBtn.addEventListener('click', () => switchMode('localFile'));
  tempModeBtn.addEventListener('click', () => switchMode('tempFile'));
  displayToggleBtn.addEventListener('click', () => {
    switchDisplayMode(displayMode === 'sourceNative' ? 'renderDisplay' : 'sourceNative');
  });
  decreaseFontBtn.addEventListener('click', () => {
    fontSize = Math.max(STICKY_NOTE_FONT_SIZE_MIN, fontSize - 1);
    applyFontSize(true);
  });
  increaseFontBtn.addEventListener('click', () => {
    fontSize = Math.min(STICKY_NOTE_FONT_SIZE_MAX, fontSize + 1);
    applyFontSize(true);
  });
  header.addEventListener('pointerdown', beginDrag);
  resizeHandle.addEventListener('pointerdown', beginResize);
  closeBtn.addEventListener('click', () => setOpen(false));
  window.addEventListener('resize', handleWindowResize);

  syncModeButtons();
  syncDisplayModeToggle();
  applyFontSize();
  applyRect();
  setOpen(false);

  return {
    open() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    toggle() {
      if (open) {
        setOpen(false);
        return;
      }
      setOpen(true);
    },
    setDocumentContent(content: string) {
      latestDocumentContent = content;
      if (mode !== 'localFile') return;
      localFileDraft = content;
      if (!open || localFileDirty) return;
      setEditorContent(content);
    },
    isOpen() {
      return open;
    },
    destroy() {
      clearLocalFileSaveTimer();
      window.removeEventListener('resize', handleWindowResize);
      editor?.destroy();
      root.remove();
    },
  };
}

function readStoredTempContent(): string {
  try {
    return localStorage.getItem(STICKY_NOTE_TEMP_CONTENT_KEY) ?? '';
  } catch {
    return '';
  }
}

function persistTempContent(content: string): void {
  try {
    localStorage.setItem(STICKY_NOTE_TEMP_CONTENT_KEY, content);
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

function readStoredMode(): StickyNoteMode {
  try {
    const raw = localStorage.getItem(STICKY_NOTE_MODE_KEY);
    return raw === 'localFile' ? 'localFile' : 'tempFile';
  } catch {
    return 'tempFile';
  }
}

function readStoredDisplayMode(): StickyNoteDisplayMode {
  try {
    const raw = localStorage.getItem(STICKY_NOTE_DISPLAY_MODE_KEY);
    return raw === 'renderDisplay' ? 'renderDisplay' : 'sourceNative';
  } catch {
    return 'sourceNative';
  }
}

function readStoredFontSize(): number {
  try {
    const raw = localStorage.getItem(STICKY_NOTE_FONT_SIZE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(STICKY_NOTE_FONT_SIZE_MIN, Math.min(STICKY_NOTE_FONT_SIZE_MAX, parsed));
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return STICKY_NOTE_FONT_SIZE_DEFAULT;
}

function persistFontSize(fontSize: number): void {
  try {
    localStorage.setItem(STICKY_NOTE_FONT_SIZE_KEY, String(fontSize));
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

function readStoredRect(): StickyRect | null {
  try {
    if (localStorage.getItem(STICKY_NOTE_RECT_VERSION_KEY) !== STICKY_NOTE_RECT_VERSION) {
      return null;
    }
    const raw = localStorage.getItem(STICKY_NOTE_RECT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StickyRect>;
    if (
      typeof parsed.left !== 'number'
      || typeof parsed.top !== 'number'
      || typeof parsed.width !== 'number'
      || typeof parsed.height !== 'number'
    ) {
      return null;
    }
    return {
      left: parsed.left,
      top: parsed.top,
      width: parsed.width,
      height: parsed.height,
    };
  } catch {
    return null;
  }
}

function persistRect(rect: StickyRect): void {
  try {
    localStorage.setItem(STICKY_NOTE_RECT_VERSION_KEY, STICKY_NOTE_RECT_VERSION);
    localStorage.setItem(STICKY_NOTE_RECT_KEY, JSON.stringify(rect));
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

function createDefaultRect(): StickyRect {
  const width = Math.min(PANEL_DEFAULT_WIDTH, Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_MARGIN * 2));
  const height = Math.min(PANEL_DEFAULT_HEIGHT, Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_TOP_OFFSET - PANEL_MARGIN));
  return clampRect({
    left: window.innerWidth - width - PANEL_MARGIN,
    top: window.innerHeight - height - PANEL_MARGIN,
    width,
    height,
  });
}

function clampRect(rect: StickyRect): StickyRect {
  const maxWidth = Math.max(PANEL_MIN_WIDTH, window.innerWidth - PANEL_MARGIN * 2);
  const maxHeight = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - PANEL_MARGIN - PANEL_TOP_OFFSET);
  const width = Math.max(PANEL_MIN_WIDTH, Math.min(rect.width, maxWidth));
  const height = Math.max(PANEL_MIN_HEIGHT, Math.min(rect.height, maxHeight));
  const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN);
  const maxTop = Math.max(PANEL_TOP_OFFSET, window.innerHeight - height - PANEL_MARGIN);

  return {
    left: Math.max(PANEL_MARGIN, Math.min(rect.left, maxLeft)),
    top: Math.max(PANEL_TOP_OFFSET, Math.min(rect.top, maxTop)),
    width,
    height,
  };
}

function ensureStickyNoteStyles(): void {
  const styleId = 'easyview-sticky-note-styles';
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = `
    .easyview-sticky-note {
      position: fixed;
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
      border-radius: 14px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 94%, transparent);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(10px);
      z-index: 1200;
    }

    .easyview-sticky-note.open {
      display: flex;
    }

    .easyview-sticky-note__header {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      box-sizing: border-box;
      gap: 6px;
      min-height: 24px;
      max-height: 24px;
      padding: 0 4px 0 7px;
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
      background: color-mix(in srgb, var(--vscode-titleBar-activeBackground, var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background))) 82%, transparent);
      cursor: move;
      user-select: none;
      overflow: hidden;
    }

    .easyview-sticky-note__title {
      font-size: 10px;
      font-weight: 700;
      color: var(--vscode-foreground);
      letter-spacing: 0.02em;
      line-height: 1;
      margin: 0;
      white-space: nowrap;
    }

    .easyview-sticky-note__mode-group {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 1px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.28)) 42%, transparent);
    }

    .easyview-sticky-note__center {
      display: inline-flex;
      justify-self: center;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .easyview-sticky-note__display-mode {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 2px;
    }

    .easyview-sticky-note__display-label {
      font-size: 9px;
      line-height: 1;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      white-space: nowrap;
      opacity: 0.72;
    }

    .easyview-sticky-note__display-label.active {
      color: var(--vscode-foreground);
      opacity: 1;
      font-weight: 700;
    }

    .easyview-sticky-note__display-toggle {
      position: relative;
      width: 26px;
      height: 14px;
      border: none;
      border-radius: 999px;
      padding: 0;
      background: color-mix(in srgb, var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.28)) 42%, transparent);
      cursor: pointer;
      flex: 0 0 auto;
    }

    .easyview-sticky-note__display-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--mdpre-accent, var(--vscode-button-background, #0e639c));
      transition: transform 140ms ease;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
    }

    .easyview-sticky-note__display-toggle.render-display .easyview-sticky-note__display-thumb {
      transform: translateX(12px);
    }

    .easyview-sticky-note__display-toggle:hover {
      background: color-mix(in srgb, var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.42)) 54%, transparent);
    }

    .easyview-sticky-note__mode-btn {
      min-width: 0;
      padding: 1px 6px;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      font-size: 9px;
      line-height: 1.2;
      cursor: pointer;
      white-space: nowrap;
    }

    .easyview-sticky-note__mode-btn.active {
      background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.18));
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      font-weight: 700;
    }

    .easyview-sticky-note__mode-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.14));
      color: var(--vscode-foreground);
    }

    .easyview-sticky-note__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      cursor: pointer;
      flex: 0 0 auto;
      padding: 0;
      line-height: 1;
    }

    .easyview-sticky-note__actions {
      display: inline-flex;
      align-items: center;
      justify-self: end;
      gap: 2px;
    }

    .easyview-sticky-note__action-btn,
    .easyview-sticky-note__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-foreground));
      cursor: pointer;
      flex: 0 0 auto;
      padding: 0;
      line-height: 1;
    }

    .easyview-sticky-note__action-btn:hover,
    .easyview-sticky-note__close:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.14));
    }

    .easyview-sticky-note__action-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .easyview-sticky-note__action-btn svg,
    .easyview-sticky-note__close svg {
      width: 10px;
      height: 10px;
      display: block;
    }

    .easyview-sticky-note__body {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      padding: 0;
      background: var(--vscode-editor-background);
    }

    .easyview-sticky-note__editor {
      position: absolute;
      inset: 0;
      font-size: var(--easyview-sticky-note-font-size, 13px);
    }

    .easyview-sticky-note__editor .cm-editor,
    .easyview-sticky-note__editor .cm-scroller {
      height: 100%;
    }

    .easyview-sticky-note__editor .cm-content {
      padding: 10px 0 28px;
    }

    .easyview-sticky-note__resize {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 18px;
      height: 18px;
      cursor: nwse-resize;
      background:
        linear-gradient(135deg, transparent 0 52%, color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground)) 68%, transparent) 52% 58%, transparent 58% 100%),
        linear-gradient(135deg, transparent 0 70%, color-mix(in srgb, var(--vscode-descriptionForeground, var(--vscode-foreground)) 48%, transparent) 70% 76%, transparent 76% 100%);
      opacity: 0.85;
    }
  `;
}
