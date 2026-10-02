import {
  nextEasyViewThemeMode,
  readLocalProductTheme,
  writeLocalProductTheme,
  type EasyViewThemeMode as ThemeModeName,
} from '@easyview/contracts';

export type EasyViewAccentTheme = 'default' | 'blue' | 'orangeRed' | 'green' | 'purple' | 'cherryRed';

export interface EditorAppearanceState {
  mode: ThemeModeName;
  depth: number;
  accent: EasyViewAccentTheme;
}

type AppearanceStorage = Pick<Storage, 'getItem' | 'setItem'>;
const ACCENT_STORAGE_KEY = 'mdpre-zalman-accent-theme';
const ACCENT_THEMES: readonly EasyViewAccentTheme[] = ['default', 'blue', 'orangeRed', 'green', 'purple', 'cherryRed'];

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

/** One owner for persisted product appearance; editor instances subscribe as views. */
export class EditorAppearanceStore {
  private value: EditorAppearanceState;
  private readonly listeners = new Set<(state: Readonly<EditorAppearanceState>) => void>();

  constructor(private readonly storage: AppearanceStorage, defaultMode: ThemeModeName = 'light') {
    let depth = THEME_DEPTH_DEFAULT;
    let accent: EasyViewAccentTheme = 'default';
    try {
      const rawDepth = storage.getItem(THEME_DEPTH_STORAGE_KEY);
      if (rawDepth !== null && Number.isFinite(Number(rawDepth))) depth = clamp01(Number(rawDepth));
      const storedAccent = storage.getItem(ACCENT_STORAGE_KEY) as EasyViewAccentTheme | null;
      if (storedAccent && ACCENT_THEMES.includes(storedAccent)) accent = storedAccent;
    } catch {
      // Webview storage can be unavailable in restricted contexts.
    }
    this.value = { mode: readLocalProductTheme(storage, defaultMode), depth, accent };
    writeLocalProductTheme(storage, this.value.mode);
  }

  get state(): Readonly<EditorAppearanceState> { return this.value; }

  subscribe(listener: (state: Readonly<EditorAppearanceState>) => void): { unsubscribe(): void } {
    this.listeners.add(listener);
    return { unsubscribe: () => { this.listeners.delete(listener); } };
  }

  cycleMode(): void { this.setMode(nextEasyViewThemeMode(this.value.mode)); }
  setMode(mode: ThemeModeName, persist = true): void { this.update({ ...this.value, mode }, persist); }
  setDepth(depth: number): void { this.update({ ...this.value, depth: clamp01(depth) }); }
  setAccent(accent: EasyViewAccentTheme): void { this.update({ ...this.value, accent }); }

  private update(next: EditorAppearanceState, persist = true): void {
    const previous = this.value;
    if (previous.mode === next.mode && previous.depth === next.depth && previous.accent === next.accent) return;
    this.value = next;
    if (persist) {
      try {
        if (previous.mode !== next.mode) writeLocalProductTheme(this.storage, next.mode);
        if (previous.depth !== next.depth) this.storage.setItem(THEME_DEPTH_STORAGE_KEY, String(next.depth));
        if (previous.accent !== next.accent) this.storage.setItem(ACCENT_STORAGE_KEY, next.accent);
      } catch {
        // Webview storage can be unavailable in restricted contexts.
      }
    }
    this.listeners.forEach((listener) => listener(this.value));
  }
}

export function applyEditorAppearance(root: HTMLElement, state: Readonly<EditorAppearanceState>): void {
  root.classList.toggle('mdpre-light', state.mode === 'light');
  root.classList.toggle('mdpre-gray', state.mode === 'gray');
  root.classList.toggle('mdpre-dark', state.mode === 'dark');
  root.dataset.easyviewTheme = state.mode;
  root.dataset.mdpreAccent = state.accent;
  applyThemeDepthColors(state.mode, state.depth, root);
}
