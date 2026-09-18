import { Terminal, type FontWeight } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TerminalAppearance {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: string;
  fontWeightBold?: string;
  letterSpacing?: number;
}

const TERMINAL_MODAL_MARGIN_X = 32;
const TERMINAL_MODAL_MARGIN_Y = 72;
const TERMINAL_MODAL_DEFAULT_WIDTH = 920;
const TERMINAL_MODAL_DEFAULT_HEIGHT = 420;
const TERMINAL_MODAL_MIN_WIDTH = 420;
const TERMINAL_MODAL_MIN_HEIGHT = 260;

function ensureTerminalModalStyles(): void {
  const styleId = 'easyview-terminal-modal-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .easyview-terminal-modal {
      position: fixed;
      right: 22px;
      bottom: 22px;
      width: 920px;
      height: 420px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 72px);
      min-width: 420px;
      min-height: 260px;
      display: none;
      flex-direction: column;
      z-index: 1400;
      overflow: hidden;
      resize: both;
      border: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.24));
      border-radius: 12px;
      background: var(--vscode-editor-background, #111827);
      box-shadow: 0 16px 44px rgba(0, 0, 0, 0.32);
      backdrop-filter: blur(10px);
    }

    .easyview-terminal-modal.visible {
      display: flex;
    }

    .easyview-terminal-modal.pinned {
      z-index: 2200;
      box-shadow: 0 20px 52px rgba(0, 0, 0, 0.42);
    }

    .easyview-terminal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 2px 6px 2px 10px;
      min-height: 24px;
      cursor: move;
      user-select: none;
      background: color-mix(in srgb, var(--vscode-titleBar-activeBackground, #1f2937) 84%, transparent);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(127, 127, 127, 0.16));
    }

    .easyview-terminal-titlebox {
      min-width: 0;
      display: flex;
      align-items: center;
    }

    .easyview-terminal-title {
      font-size: 10px;
      font-weight: 650;
      color: var(--vscode-editor-foreground, #f8fafc);
      line-height: 1;
    }

    .easyview-terminal-actions {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .easyview-terminal-btn {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 8px;
      color: var(--vscode-editor-foreground, #e5e7eb);
      background: transparent;
      cursor: pointer;
    }

    .easyview-terminal-btn:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(148, 163, 184, 0.14));
    }

    .easyview-terminal-btn.active {
      color: #f8fafc;
      background: rgba(59, 130, 246, 0.24);
    }

    .easyview-terminal-font-size-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--vscode-editor-foreground, #94a3b8);
      opacity: 0.7;
      min-width: 22px;
      text-align: center;
      user-select: none;
      pointer-events: none;
    }

    .easyview-terminal-body {
      position: relative;
      flex: 1;
      min-height: 0;
      padding: 0;
      background: var(--vscode-editor-background, #0b1020);
    }

    .easyview-terminal-xterm {
      width: 100%;
      height: 100%;
      border-radius: 0 0 12px 12px;
      overflow: hidden;
      background: var(--vscode-editor-background, #0b1020);
    }

    .easyview-terminal-modal .xterm {
      height: 100%;
      padding: 8px 10px;
      letter-spacing: 0 !important;
      word-spacing: 0 !important;
      font-kerning: none !important;
      font-variant-ligatures: none !important;
      text-rendering: optimizeSpeed;
      background: var(--vscode-editor-background, #0b1020) !important;
    }

    .easyview-terminal-modal .xterm * {
      letter-spacing: 0 !important;
      word-spacing: 0 !important;
      font-kerning: none !important;
      font-variant-ligatures: none !important;
    }

    .easyview-terminal-modal .xterm-viewport,
    .easyview-terminal-modal .xterm-screen,
    .easyview-terminal-modal canvas {
      background: var(--vscode-editor-background, #0b1020) !important;
    }

    .xterm-char-measure-element {
      letter-spacing: 0 !important;
      word-spacing: 0 !important;
      font-kerning: none !important;
      font-variant-ligatures: none !important;
    }

    .easyview-terminal-modal .xterm .xterm-rows,
    .easyview-terminal-modal .xterm .xterm-rows span,
    .easyview-terminal-modal .xterm .xterm-accessibility-tree,
    .easyview-terminal-modal .xterm .xterm-accessibility-tree div {
      letter-spacing: 0 !important;
      word-spacing: 0 !important;
      font-kerning: none !important;
      font-variant-ligatures: none !important;
    }
  `;
  document.head.appendChild(style);
}

export interface TerminalModal {
  toggle: () => void;
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  updateAppearance: (appearance?: TerminalAppearance) => void;
  handleMessage: (message: HostToEditorMessage) => boolean;
  destroy: () => void;
}

export function createTerminalModal(options: {
  postMessage: (message: EditorToHostMessage) => void;
  appearance?: TerminalAppearance;
  onVisibilityChange?: (visible: boolean) => void;
}): TerminalModal {
  ensureTerminalModalStyles();

  const root = document.createElement('div');
  root.className = 'easyview-terminal-modal';
  root.innerHTML = `
    <div class="easyview-terminal-header">
      <div class="easyview-terminal-titlebox">
        <div class="easyview-terminal-title">Terminal</div>
      </div>
      <div class="easyview-terminal-actions">
        <button class="easyview-terminal-btn" data-action="font-decrease" type="button" title="Decrease font size">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <span class="easyview-terminal-font-size-label" data-role="font-size-label">--</span>
        <button class="easyview-terminal-btn" data-action="font-increase" type="button" title="Increase font size">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="easyview-terminal-btn" data-action="pin" type="button" title="Pin terminal window">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M7 7V3h10v4"/><path d="M5 7h14l-3 6H8z"/></svg>
        </button>
        <button class="easyview-terminal-btn" data-action="close" type="button" title="Close terminal window">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
    </div>
    <div class="easyview-terminal-body">
      <div class="easyview-terminal-xterm"></div>
    </div>
  `;
  document.body.appendChild(root);

  const header = root.querySelector('.easyview-terminal-header') as HTMLElement;
  const fontDecreaseBtn = root.querySelector('[data-action="font-decrease"]') as HTMLButtonElement;
  const fontIncreaseBtn = root.querySelector('[data-action="font-increase"]') as HTMLButtonElement;
  const fontSizeLabel = root.querySelector('[data-role="font-size-label"]') as HTMLElement;
  const pinBtn = root.querySelector('[data-action="pin"]') as HTMLButtonElement;
  const closeBtn = root.querySelector('[data-action="close"]') as HTMLButtonElement;
  const host = root.querySelector('.easyview-terminal-xterm') as HTMLElement;

  let terminal: Terminal | null = null;
  let terminalDataDisposable: { dispose: () => void } | null = null;
  let fitAddon: FitAddon | null = null;
  let openState = false;
  let pinned = false;
  let sessionId = '';
  let resizeObserver: ResizeObserver | null = null;
  let dragState: { pointerId: number; startX: number; startY: number; startLeft: number; startTop: number } | null = null;
  let appearance: TerminalAppearance = options.appearance ?? {};
  let hasReceivedTerminalData = false;
  let boundsInitialized = false;
  let fitSequenceToken = 0;
  let resizePostTimer: number | null = null;
  let lastPostedCols = 0;
  let lastPostedRows = 0;
  // Local font size override controlled by the +/- buttons
  // null means use the appearance value (from VS Code settings)
  let localFontSizeOverride: number | null = null;
  let disposed = false;
  const pendingTimeouts = new Set<number>();
  const pendingAnimationFrames = new Set<number>();

  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 28;

  const getEffectiveFontSize = (): number => {
    if (localFontSizeOverride !== null) return localFontSizeOverride;
    return typeof appearance.fontSize === 'number' && appearance.fontSize > 0 ? appearance.fontSize : 12.5;
  };

  const updateFontSizeLabel = (): void => {
    fontSizeLabel.textContent = `${Math.round(getEffectiveFontSize())}px`;
  };

  const getThemeColors = () => {
    const computed = getComputedStyle(document.body);
    return {
      background: (computed.getPropertyValue('--vscode-editor-background').trim() || '#0b1020'),
      foreground: (computed.getPropertyValue('--vscode-editor-foreground').trim() || '#e5e7eb'),
      selection: (computed.getPropertyValue('--vscode-editor-selectionBackground').trim() || 'rgba(59, 130, 246, 0.28)'),
    };
  };

  const resolveTerminalFontFamily = (): string => {
    const configured = (appearance.fontFamily || '').trim();
    // Always append reliable monospace fallback fonts to prevent xterm from
    // falling back to a CJK proportional font (e.g. Microsoft YaHei) when the
    // user-configured CJK monospace font (e.g. Sarasa Mono SC) is not available
    // inside the VS Code webview context (CSP blocks system font loading).
    // Without this, cellWidth = ~14.8px (YaHei) instead of ~7.5px (Menlo),
    // causing xterm to compute far fewer columns → blank space on the right.
    const monoFallback = 'Menlo, Monaco, "Courier New", monospace';
    if (!configured) return monoFallback;
    // Avoid duplicating if user already ended with a safe monospace family
    const lower = configured.toLowerCase();
    if (lower.endsWith('monospace') || lower.includes('menlo') || lower.includes('monaco') || lower.includes('consolas') || lower.includes('courier')) {
      return configured;
    }
    return `${configured}, ${monoFallback}`;
  };

  const applyAppearance = (): void => {
    const fontFamily = resolveTerminalFontFamily();
    const fontSize = getEffectiveFontSize();
    const lineHeight = typeof appearance.lineHeight === 'number' && appearance.lineHeight > 0 ? appearance.lineHeight : 1;
    const fontWeight = appearance.fontWeight || 'normal';

    options.postMessage({
      type: 'openWithDebugLog',
      stage: 'terminalApplyAppearance',
      meta: {
        v: '1.0.242',
        fontFamily,
        fontSize,
        lineHeight,
      },
    });

    host.style.fontFamily = fontFamily;
    host.style.fontSize = `${fontSize}px`;
    host.style.lineHeight = String(lineHeight);
    host.style.fontWeight = fontWeight;

    root.style.setProperty('--easyview-terminal-font-family', fontFamily);
    root.style.setProperty('--easyview-terminal-font-size', `${fontSize}px`);
    root.style.setProperty('--easyview-terminal-line-height', String(lineHeight));
    root.style.setProperty('--easyview-terminal-font-weight', fontWeight);
    document.body.style.setProperty('--easyview-terminal-font-family', fontFamily);
    document.body.style.setProperty('--easyview-terminal-font-size', `${fontSize}px`);
    document.body.style.setProperty('--easyview-terminal-line-height', String(lineHeight));
    document.body.style.setProperty('--easyview-terminal-font-weight', fontWeight);

    if (!terminal) return;
    const colors = getThemeColors();
    terminal.options.fontFamily = fontFamily;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    terminal.options.fontWeight = fontWeight as FontWeight;
    terminal.options.fontWeightBold = (appearance.fontWeightBold || 'bold') as FontWeight;
    terminal.options.letterSpacing = typeof appearance.letterSpacing === 'number' ? appearance.letterSpacing : 0;
    terminal.options.theme = {
      background: colors.background,
      foreground: colors.foreground,
      cursor: '#93c5fd',
      cursorAccent: colors.background,
      selectionBackground: colors.selection,
      black: '#111827',
      red: '#f87171',
      green: '#4ade80',
      yellow: '#fbbf24',
      blue: '#60a5fa',
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: '#e5e7eb',
      brightBlack: '#475569',
      brightRed: '#fca5a5',
      brightGreen: '#86efac',
      brightYellow: '#fde68a',
      brightBlue: '#93c5fd',
      brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9',
      brightWhite: '#f8fafc',
    };
  };

  const scheduleTimeout = (callback: () => void, delay: number): number => {
    const timerId = window.setTimeout(() => {
      pendingTimeouts.delete(timerId);
      if (disposed) return;
      callback();
    }, delay);
    pendingTimeouts.add(timerId);
    return timerId;
  };

  const scheduleAnimationFrame = (callback: () => void): number => {
    const frameId = window.requestAnimationFrame(() => {
      pendingAnimationFrames.delete(frameId);
      if (disposed) return;
      callback();
    });
    pendingAnimationFrames.add(frameId);
    return frameId;
  };

  const clearScheduledTasks = (): void => {
    for (const timerId of pendingTimeouts) window.clearTimeout(timerId);
    pendingTimeouts.clear();
    for (const frameId of pendingAnimationFrames) window.cancelAnimationFrame(frameId);
    pendingAnimationFrames.clear();
    fitSequenceToken += 1;
  };

  const refreshAfterFontReady = (): void => {
    if (disposed) return;
    const family = resolveTerminalFontFamily();
    const size = typeof appearance.fontSize === 'number' && appearance.fontSize > 0 ? appearance.fontSize : 12.5;
    const weight = appearance.fontWeight || 'normal';
    const fontsApi = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fontsApi || typeof fontsApi.load !== 'function') return;
    void fontsApi.load(`${weight} ${size}px ${family}`).then(() => {
      if (disposed) return;
      scheduleFitSequence('fontReady');
      scheduleAnimationFrame(() => {
        terminal?.refresh(0, Math.max(0, (terminal?.rows || 1) - 1));
      });
    }).catch(() => {
      // Ignore font loading failures and keep fallback rendering.
    });
  };

  const ensureTerminal = (): void => {
    if (disposed || terminal) return;
    fitAddon = new FitAddon();
    applyAppearance();
    terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: true,
      fontFamily: resolveTerminalFontFamily(),
      fontSize: getEffectiveFontSize(),
      lineHeight: typeof appearance.lineHeight === 'number' && appearance.lineHeight > 0 ? appearance.lineHeight : 1,
      fontWeight: (appearance.fontWeight || 'normal') as FontWeight,
      fontWeightBold: (appearance.fontWeightBold || 'bold') as FontWeight,
      letterSpacing: typeof appearance.letterSpacing === 'number' ? appearance.letterSpacing : 0,
    });
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    applyAppearance();
    refreshAfterFontReady();
    terminalDataDisposable = terminal.onData((data) => {
      if (!openState || !sessionId) return;
      const sanitized = data.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, '');
      if (!sanitized) return;
      options.postMessage({ type: 'terminalInput', data: sanitized });
    });
    resizeObserver = new ResizeObserver(() => {
      if (!terminal || !fitAddon || !openState) return;
      scheduleFitSequence('resize');
    });
    resizeObserver.observe(host);
  };

  const focusTerminal = (): void => {
    terminal?.focus();
  };

  const clampModalBounds = (): void => {
    const maxWidth = Math.max(TERMINAL_MODAL_MIN_WIDTH, window.innerWidth - TERMINAL_MODAL_MARGIN_X);
    const maxHeight = Math.max(TERMINAL_MODAL_MIN_HEIGHT, window.innerHeight - TERMINAL_MODAL_MARGIN_Y);
    const rect = root.getBoundingClientRect();
    const width = Math.max(TERMINAL_MODAL_MIN_WIDTH, Math.min(rect.width || TERMINAL_MODAL_DEFAULT_WIDTH, maxWidth));
    const height = Math.max(TERMINAL_MODAL_MIN_HEIGHT, Math.min(rect.height || TERMINAL_MODAL_DEFAULT_HEIGHT, maxHeight));
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;

    if (root.style.left) {
      const maxLeft = Math.max(0, window.innerWidth - width);
      const nextLeft = Math.max(0, Math.min(maxLeft, parseFloat(root.style.left || '0') || 0));
      root.style.left = `${nextLeft}px`;
    }
    if (root.style.top) {
      const maxTop = Math.max(0, window.innerHeight - height);
      const nextTop = Math.max(0, Math.min(maxTop, parseFloat(root.style.top || '0') || 0));
      root.style.top = `${nextTop}px`;
    }
  };

  const initializeModalBounds = (): void => {
    if (boundsInitialized) return;
    boundsInitialized = true;
    const width = Math.max(
      TERMINAL_MODAL_MIN_WIDTH,
      Math.min(TERMINAL_MODAL_DEFAULT_WIDTH, window.innerWidth - TERMINAL_MODAL_MARGIN_X)
    );
    const height = Math.max(
      TERMINAL_MODAL_MIN_HEIGHT,
      Math.min(TERMINAL_MODAL_DEFAULT_HEIGHT, window.innerHeight - TERMINAL_MODAL_MARGIN_Y)
    );
    root.style.width = `${width}px`;
    root.style.height = `${height}px`;
  };

  const clearResizePostTimer = (): void => {
    if (resizePostTimer !== null) {
      window.clearTimeout(resizePostTimer);
      pendingTimeouts.delete(resizePostTimer);
      resizePostTimer = null;
    }
  };

  const flushTerminalResize = (): void => {
    resizePostTimer = null;
    if (disposed) return;
    if (!terminal || !sessionId) return;
    if (lastPostedCols === terminal.cols && lastPostedRows === terminal.rows) return;
    lastPostedCols = terminal.cols;
    lastPostedRows = terminal.rows;
    options.postMessage({ type: 'terminalResize', cols: terminal.cols, rows: terminal.rows });
  };

  const scheduleTerminalResizePost = (): void => {
    if (!sessionId) return;
    clearResizePostTimer();
    resizePostTimer = scheduleTimeout(() => {
      flushTerminalResize();
    }, 80);
  };

  const fitTerminal = (reason: string): void => {
    if (!terminal || !fitAddon || !openState) return;
    applyAppearance();

    const current = terminal.options.fontSize;
    if (typeof current === 'number' && current > 0) {
      terminal.options.fontSize = current + 0.001;
      terminal.options.fontSize = current;
    }

    // Rely entirely on xterm's FitAddon, which already reads .xterm's CSS
    // padding (via getComputedStyle) and subtracts it from available width.
    // Prior custom logic subtracted .xterm's padding AGAIN from host.clientWidth,
    // double-counting it and producing fewer columns → blank space on the right.
    const proposed = fitAddon.proposeDimensions();
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return;

    if (terminal.cols !== proposed.cols || terminal.rows !== proposed.rows) {
      terminal.resize(proposed.cols, proposed.rows);
    }

    scheduleTerminalResizePost();

    const termElement = terminal.element as HTMLElement | undefined;
    const screenElement = termElement?.querySelector('.xterm-screen') as HTMLElement | null;
    const screenCanvas = termElement?.querySelector('.xterm-screen canvas') as HTMLCanvasElement | null;
    const xtermStyle = termElement ? getComputedStyle(termElement) : null;
    const core = (terminal as Terminal & {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: {
                width?: number;
                height?: number;
              };
            };
          };
        };
      };
    })._core;
    const cellWidth = core?._renderService?.dimensions?.css?.cell?.width ?? 0;
    const cellHeight = core?._renderService?.dimensions?.css?.cell?.height ?? 0;

    options.postMessage({
      type: 'openWithDebugLog',
      stage: 'terminalFitMetrics',
      meta: {
        reason,
        sessionReady: Boolean(sessionId),
        modalWidth: Math.round(root.getBoundingClientRect().width),
        modalHeight: Math.round(root.getBoundingClientRect().height),
        hostClientWidth: host.clientWidth,
        hostClientHeight: host.clientHeight,
        xtermPaddingLeft: parseFloat(xtermStyle?.paddingLeft || '0') || 0,
        xtermPaddingRight: parseFloat(xtermStyle?.paddingRight || '0') || 0,
        screenWidth: Math.round(screenElement?.getBoundingClientRect().width ?? 0),
        canvasWidth: Math.round(screenCanvas?.getBoundingClientRect().width ?? 0),
        cellWidth: Number(cellWidth.toFixed(3)),
        cellHeight: Number(cellHeight.toFixed(3)),
        proposedCols: proposed.cols,
        proposedRows: proposed.rows,
        actualCols: terminal.cols,
        actualRows: terminal.rows,
      },
    });
  };

  const scheduleFitSequence = (reason: string): void => {
    const token = ++fitSequenceToken;
    const runFit = (label: string) => {
      if (token !== fitSequenceToken || !openState) return;
      fitTerminal(`${reason}:${label}`);
    };
    scheduleAnimationFrame(() => runFit('raf'));
    scheduleTimeout(() => runFit('t40'), 40);
    scheduleTimeout(() => runFit('t140'), 140);
    scheduleTimeout(() => runFit('t280'), 280);
  };

  const setVisible = (visible: boolean): void => {
    if (disposed) return;
    openState = visible;
    root.classList.toggle('visible', visible);
    options.onVisibilityChange?.(visible);
    if (visible) {
      initializeModalBounds();
      clampModalBounds();
      updateFontSizeLabel();
      ensureTerminal();
      terminal?.clear();
      sessionId = '';
      hasReceivedTerminalData = false;
      lastPostedCols = 0;
      lastPostedRows = 0;
      clearResizePostTimer();
      scheduleAnimationFrame(() => {
        scheduleFitSequence('open');
        focusTerminal();
      });
      options.postMessage({ type: 'openTerminal' });
    } else {
      clearResizePostTimer();
      fitSequenceToken += 1;
      options.postMessage({ type: 'terminalClose' });
      sessionId = '';
    }
  };

  const open = (): void => {
    if (disposed) return;
    if (openState) {
      focusTerminal();
      return;
    }
    setVisible(true);
  };

  const close = (): void => {
    if (disposed || !openState) return;
    setVisible(false);
  };

  const toggle = (): void => {
    if (disposed) return;
    if (openState) close();
    else open();
  };

  fontDecreaseBtn.addEventListener('click', () => {
    const next = Math.max(FONT_SIZE_MIN, getEffectiveFontSize() - 1);
    localFontSizeOverride = next;
    updateFontSizeLabel();
    if (terminal) {
      terminal.options.fontSize = next + 0.001;
      terminal.options.fontSize = next;
    }
    scheduleFitSequence('fontDecrease');
  });

  fontIncreaseBtn.addEventListener('click', () => {
    const next = Math.min(FONT_SIZE_MAX, getEffectiveFontSize() + 1);
    localFontSizeOverride = next;
    updateFontSizeLabel();
    if (terminal) {
      terminal.options.fontSize = next + 0.001;
      terminal.options.fontSize = next;
    }
    scheduleFitSequence('fontIncrease');
  });

  pinBtn.addEventListener('click', () => {
    pinned = !pinned;
    root.classList.toggle('pinned', pinned);
    pinBtn.classList.toggle('active', pinned);
    pinBtn.title = pinned ? 'Unpin terminal window' : 'Pin terminal window';
  });

  closeBtn.addEventListener('click', close);

  header.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('.easyview-terminal-btn')) return;
    const rect = root.getBoundingClientRect();
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
    };
    header.setPointerCapture(event.pointerId);
  });

  header.addEventListener('pointermove', (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const maxLeft = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - root.offsetHeight);
    const nextLeft = Math.max(0, Math.min(maxLeft, dragState.startLeft + (event.clientX - dragState.startX)));
    const nextTop = Math.max(0, Math.min(maxTop, dragState.startTop + (event.clientY - dragState.startY)));
    root.style.left = `${nextLeft}px`;
    root.style.top = `${nextTop}px`;
  });

  const clearDrag = (): void => {
    dragState = null;
  };
  header.addEventListener('pointerup', clearDrag);
  header.addEventListener('pointercancel', clearDrag);

  const handleThemeChanged = (): void => {
    if (disposed) return;
    applyAppearance();
    refreshAfterFontReady();
    scheduleFitSequence('themeChanged');
  };
  const handleWindowResize = (): void => {
    if (disposed) return;
    clampModalBounds();
    if (openState) scheduleFitSequence('windowResize');
  };
  window.addEventListener('inlinemd:themeChanged', handleThemeChanged);
  window.addEventListener('resize', handleWindowResize);

  const handleMessage = (message: HostToEditorMessage): boolean => {
    if (disposed) return false;
    switch (message?.type) {
      case 'terminalOpened':
        if (!openState) return true;
        ensureTerminal();
        sessionId = typeof message.sessionId === 'string' ? message.sessionId : '';
        lastPostedCols = 0;
        lastPostedRows = 0;
        scheduleAnimationFrame(() => {
          scheduleFitSequence('terminalOpened');
          focusTerminal();
        });
        return true;

      case 'terminalData':
        if (!terminal || !openState) return true;
        terminal.write(typeof message.data === 'string' ? message.data : '');
        if (!hasReceivedTerminalData) {
          hasReceivedTerminalData = true;
          scheduleFitSequence('firstData');
        }
        return true;

      case 'terminalError':
        if (!terminal) return true;
        terminal.writeln(`\r\n[EasyView terminal error] ${String(message.message || 'Unknown error')}\r\n`);
        return true;

      case 'terminalExit':
        if (!terminal) return true;
        sessionId = '';
        terminal.writeln('\r\n[Process exited]\r\n');
        return true;

      default:
        return false;
    }
  };

  const destroy = (): void => {
    if (disposed) return;

    const shouldCloseHostSession = openState || Boolean(sessionId);
    disposed = true;
    openState = false;
    clearResizePostTimer();
    clearScheduledTasks();
    dragState = null;

    if (shouldCloseHostSession) {
      options.postMessage({ type: 'terminalClose' });
    }
    sessionId = '';

    window.removeEventListener('inlinemd:themeChanged', handleThemeChanged);
    window.removeEventListener('resize', handleWindowResize);
    resizeObserver?.disconnect();
    resizeObserver = null;
    terminalDataDisposable?.dispose();
    terminalDataDisposable = null;
    fitAddon?.dispose();
    fitAddon = null;
    terminal?.dispose();
    terminal = null;
    root.remove();
  };

  return {
    toggle,
    open,
    close,
    isOpen: () => openState,
    updateAppearance(nextAppearance?: TerminalAppearance) {
      if (disposed) return;
      appearance = { ...appearance, ...(nextAppearance ?? {}) };
      applyAppearance();
      refreshAfterFontReady();
      scheduleFitSequence('appearanceChanged');
    },
    handleMessage,
    destroy,
  };
}
import type { HostToEditorMessage, EditorToHostMessage } from '@easyview/contracts/protocol';
