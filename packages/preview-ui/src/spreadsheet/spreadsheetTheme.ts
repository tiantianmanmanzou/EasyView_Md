import type { EasyViewThemeMode } from '@easyview/contracts';
import { EASYVIEW_THEME_PALETTE } from '@easyview/contracts';
import type { XsDataLike, XsDrawLike, XsSpreadsheetLike, XsStyleLike } from './xSpreadsheetTypes';

/** Canvas chrome + default cell colors driven by EasyView theme (not IDE). */
export interface SpreadsheetCanvasTheme {
  cellBg: string;
  cellFg: string;
  headerBg: string;
  headerFg: string;
  grid: string;
  cornerBg: string;
}

const CHROME_BY_THEME: Record<EasyViewThemeMode, Omit<SpreadsheetCanvasTheme, 'cellBg' | 'cellFg'>> = {
  light: {
    headerBg: '#f4f5f8',
    headerFg: '#585757',
    grid: '#e6e6e6',
    cornerBg: '#f4f5f8',
  },
  gray: {
    headerBg: '#9aa1ac',
    headerFg: '#050608',
    grid: '#7a8290',
    cornerBg: '#9aa1ac',
  },
  dark: {
    headerBg: '#2d2d2d',
    headerFg: '#d4d4d4',
    grid: '#3c3c3c',
    cornerBg: '#2d2d2d',
  },
};

export function spreadsheetCanvasTheme(mode: EasyViewThemeMode): SpreadsheetCanvasTheme {
  const palette = EASYVIEW_THEME_PALETTE[mode];
  return {
    cellBg: palette.background,
    cellFg: palette.textColor,
    ...CHROME_BY_THEME[mode],
  };
}

/** Default x-spreadsheet style fragment passed at construction / updated on theme change. */
export function spreadsheetDefaultStyle(mode: EasyViewThemeMode): { bgcolor: string; color: string } {
  const theme = spreadsheetCanvasTheme(mode);
  return { bgcolor: theme.cellBg, color: theme.cellFg };
}

export function normalizeCssHex(color: string): string {
  const raw = color.trim().toLowerCase();
  if (raw === '#fff') return '#ffffff';
  if (raw === '#000') return '#000000';
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
  }
  return raw;
}

function luminance(hex: string): number | null {
  const n = normalizeCssHex(hex);
  if (!/^#[0-9a-f]{6}$/.test(n)) return null;
  const r = Number.parseInt(n.slice(1, 3), 16) / 255;
  const g = Number.parseInt(n.slice(3, 5), 16) / 255;
  const b = Number.parseInt(n.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Channel spread below this is gray. Header chrome #f4f5f8 (spread 4) stays themeable.
 * Excel accent tints such as #deebf7 (spread 25) must keep their fill.
 */
const NEUTRAL_CHANNEL_SPREAD = 16;

/** Low-chroma colors only — keeps yellow/green and tinted accent fills out of theme remapping. */
function isNearNeutral(hex: string): boolean {
  const n = normalizeCssHex(hex);
  if (!/^#[0-9a-f]{6}$/.test(n)) return false;
  const r = Number.parseInt(n.slice(1, 3), 16);
  const g = Number.parseInt(n.slice(3, 5), 16);
  const b = Number.parseInt(n.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) <= NEUTRAL_CHANNEL_SPREAD;
}

/** Point sizes x-spreadsheet already converts. Anything else is drawn as that many pixels. */
const LIBRARY_FONT_PT = new Set([7.5, 8, 9, 10, 10.5, 11, 12, 14, 15, 16, 18, 22, 24, 26, 36, 42]);

/** Leave mapped sizes in points so the library converts them once. Convert the rest to CSS pixels. */
export function fontSizeForCanvas(pt: number): number {
  return LIBRARY_FONT_PT.has(pt) ? pt : pt * 96 / 72;
}

const CJK_FONT_STACKS: Record<string, string> = {
  '宋体': '"Songti SC", SimSun, STSong, serif',
  '宋体-简': '"Songti SC", SimSun, STSong, serif',
  simsun: '"Songti SC", SimSun, STSong, serif',
  '等线': '"PingFang SC", "Microsoft YaHei", sans-serif',
  dengxian: '"PingFang SC", "Microsoft YaHei", sans-serif',
  '微软雅黑': '"PingFang SC", "Microsoft YaHei", sans-serif',
  'microsoft yahei': '"PingFang SC", "Microsoft YaHei", sans-serif',
  '黑体': '"Heiti SC", SimHei, sans-serif',
  simhei: '"Heiti SC", SimHei, sans-serif',
  '楷体': '"Kaiti SC", KaiTi, serif',
  kaiti: '"Kaiti SC", KaiTi, serif',
};

/** Canvas family for a CJK face that is usually missing on macOS. Other names stay as stored. */
export function canvasFontFamily(name: string): string {
  const trimmed = name.trim();
  return CJK_FONT_STACKS[trimmed] ?? CJK_FONT_STACKS[trimmed.toLowerCase()] ?? name;
}

/** Draw-only style: unmapped point sizes become pixels, and CJK names map to installed faces. */
export function styleForDraw(style: XsStyleLike): XsStyleLike {
  const font = style.font;
  if (!font || typeof font !== 'object') return style;
  const source = font as { name?: string; size?: number; bold?: boolean; italic?: boolean };
  const nextFont = { ...source };
  let changed = false;
  if (typeof source.size === 'number') {
    const size = fontSizeForCanvas(source.size);
    if (size !== source.size) {
      nextFont.size = size;
      changed = true;
    }
  }
  if (typeof source.name === 'string') {
    const name = canvasFontFamily(source.name);
    if (name !== source.name) {
      nextFont.name = name;
      changed = true;
    }
  }
  return changed ? { ...style, font: nextFont } : style;
}

/** Near-white / Excel lt1 — treat as theme surface, keep green/yellow/etc. */
export function isThemeableBackground(color: string | undefined): boolean {
  if (!color) return true;
  const lum = luminance(color);
  if (lum == null) return false;
  return lum >= 0.9 && isNearNeutral(color);
}

/** Near-black / Excel dk1 — treat as theme text. */
export function isThemeableForeground(color: string | undefined): boolean {
  if (!color) return true;
  const lum = luminance(color);
  if (lum == null) return false;
  return lum <= 0.18 && isNearNeutral(color);
}


export function adaptCellStyleForTheme(style: XsStyleLike, mode: EasyViewThemeMode): XsStyleLike {
  const theme = spreadsheetCanvasTheme(mode);
  const next: XsStyleLike = { ...style };
  if (isThemeableBackground(typeof next.bgcolor === 'string' ? next.bgcolor : undefined)) {
    next.bgcolor = theme.cellBg;
  }
  if (isThemeableForeground(typeof next.color === 'string' ? next.color : undefined)) {
    next.color = theme.cellFg;
  }
  return next;
}


const STYLE_HOOK = '__easyviewGetCellStyleOrDefault';
const DRAW_HOOK = '__easyviewDrawAttr';
const THEME_REF = '__easyviewThemeMode';

/**
 * Sync x-spreadsheet canvas defaults + neutral cell colors + header/grid paints
 * to the active EasyView theme. Explicit fills (green/yellow/…) stay unchanged.
 */
export function applyXSpreadsheetTheme(spreadsheet: XsSpreadsheetLike | null | undefined, mode: EasyViewThemeMode): void {
  if (!spreadsheet) return;
  const defaults = spreadsheetDefaultStyle(mode);
  const datas = Array.isArray(spreadsheet.datas) && spreadsheet.datas.length > 0
    ? spreadsheet.datas
    : spreadsheet.data
      ? [spreadsheet.data]
      : [];

  (spreadsheet as { [THEME_REF]?: EasyViewThemeMode })[THEME_REF] = mode;

  for (const data of datas) {
    if (!data) continue;
    if (!data.settings) data.settings = {};
    if (!data.settings.style) data.settings.style = {};
    data.settings.style.bgcolor = defaults.bgcolor;
    data.settings.style.color = defaults.color;
    installCellStyleHook(data, () => (spreadsheet as { [THEME_REF]?: EasyViewThemeMode })[THEME_REF] ?? mode);
  }

  const draw = spreadsheet.sheet?.table?.draw;
  if (draw) {
    installDrawAttrHook(draw, () => spreadsheetCanvasTheme(
      (spreadsheet as { [THEME_REF]?: EasyViewThemeMode })[THEME_REF] ?? mode,
    ));
  }

  // Ensure next paints use updated defaults/hooks.
  if (typeof spreadsheet.reRender === 'function') spreadsheet.reRender();
  else spreadsheet.sheet?.table?.render?.();
}

function installCellStyleHook(data: XsDataLike, getMode: () => EasyViewThemeMode): void {
  const anyData = data as XsDataLike & { [STYLE_HOOK]?: boolean };
  if (anyData[STYLE_HOOK] || typeof data.getCellStyleOrDefault !== 'function') return;
  const original = data.getCellStyleOrDefault.bind(data);
  // Drawing reads this. The toolbar reads getSelectedCellStyle, which must stay in points
  // and keep the stored font name (20pt drawn as 20px was the mismatch with Excel).
  data.getCellStyleOrDefault = (ri: number, ci: number) => styleForDraw(adaptCellStyleForTheme(original(ri, ci) || {}, getMode()));
  if (typeof anyData.getSelectedCellStyle === 'function') {
    anyData.getSelectedCellStyle = () => {
      const ri = anyData.selector?.ri ?? 0;
      const ci = anyData.selector?.ci ?? 0;
      return adaptCellStyleForTheme(original(ri, ci) || {}, getMode());
    };
  }
  anyData[STYLE_HOOK] = true;
}

function installDrawAttrHook(draw: XsDrawLike, getTheme: () => SpreadsheetCanvasTheme): void {
  const anyDraw = draw as XsDrawLike & { [DRAW_HOOK]?: boolean };
  if (anyDraw[DRAW_HOOK]) return;
  const original = draw.attr.bind(draw);
  draw.attr = (options: Record<string, unknown>) => {
    const theme = getTheme();
    const next = { ...options };
    if (typeof next.fillStyle === 'string') {
      const fill = normalizeCssHex(next.fillStyle);
      // Header chrome only — do not remap #fff (also used as cell text color).
      if (fill === '#f4f5f8') next.fillStyle = theme.headerBg;
      else if (fill === '#585757') next.fillStyle = theme.headerFg;
    }
    if (typeof next.strokeStyle === 'string') {
      const stroke = normalizeCssHex(next.strokeStyle);
      if (stroke === '#e6e6e6') next.strokeStyle = theme.grid;
    }
    return original(next);
  };
  anyDraw[DRAW_HOOK] = true;
}
