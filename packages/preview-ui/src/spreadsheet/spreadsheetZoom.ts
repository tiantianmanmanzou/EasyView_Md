import type { XsDrawLike, XsSpreadsheetLike } from './xSpreadsheetTypes';

export const MIN_ZOOM_PERCENT = 10;
export const MAX_ZOOM_PERCENT = 400;
export const ZOOM_PRESETS = [10, 25, 50, 75, 85, 100, 125, 150, 200, 300, 400];

export interface SpreadsheetZoom {
  /** 1 = 100%. Read on every paint so the stored column widths stay unscaled. */
  scale: number;
}

interface AxisCell {
  width?: number;
  height?: number;
  hide?: boolean;
  cells?: Record<number, { text?: unknown; merge?: [number, number] }>;
}

interface ZoomCols {
  width: number;
  indexWidth: number;
  _: Record<number, AxisCell | undefined>;
  isHide(i: number): boolean;
  getWidth(i: number): number;
  setWidth(i: number, width: number): void;
}

interface ZoomRows {
  height: number;
  _: Record<number, AxisCell | undefined>;
  isHide(i: number): boolean;
  get(i: number): AxisCell | undefined;
  getHeight(i: number): number;
  setHeight(i: number, height: number): void;
}

interface ZoomData {
  cols?: ZoomCols;
  rows?: ZoomRows;
}

const GRID_FLAG = '__easyviewZoomGrid';
const TEXT_FLAG = '__easyviewTextZoom';
const HEADER_FLAG = '__easyviewHeaderZoom';

export function clampZoom(percent: number): number {
  if (!Number.isFinite(percent)) return 100;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(percent)));
}

export function zoomChoices(current: number): number[] {
  return [...new Set([...ZOOM_PRESETS, clampZoom(current)])].sort((a, b) => a - b);
}

/**
 * Trackpad pinch (Chromium reports it as ctrl+wheel): positive deltaY zooms out.
 * Exponential so small pinches feel smooth and large ones still stay in range.
 */
export function zoomPercentAfterWheel(percent: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoom(percent);
  return clampZoom(percent * Math.exp(-deltaY * 0.008));
}

/**
 * After scale changes, reload the sheet so scrollbars and the selection overlay
 * remeasure against the new row/column sizes (reRender alone leaves the box behind).
 */
export function refreshSpreadsheetAfterZoom(spreadsheet: XsSpreadsheetLike | null | undefined): void {
  if (!spreadsheet) return;
  const sheet = spreadsheet.sheet;
  if (typeof sheet?.reload === 'function') {
    sheet.reload();
    return;
  }
  spreadsheet.reRender?.();
  sheet?.selector?.resetAreaOffset?.();
}

function scaleOf(zoom: SpreadsheetZoom): number {
  return zoom.scale > 0 ? zoom.scale : 1;
}

function datasOf(spreadsheet: XsSpreadsheetLike): ZoomData[] {
  if (Array.isArray(spreadsheet.datas) && spreadsheet.datas.length > 0) return spreadsheet.datas as ZoomData[];
  return spreadsheet.data ? [spreadsheet.data as ZoomData] : [];
}

/**
 * Scale column, row and header metrics, plus the already-pixel font size, without
 * writing the scaled numbers into the sheet. Saving still persists the 100% sizes.
 */
export function bindSpreadsheetZoom(spreadsheet: XsSpreadsheetLike | null | undefined, zoom: SpreadsheetZoom): void {
  if (!spreadsheet) return;
  for (const data of datasOf(spreadsheet)) installGridScale(data, zoom);
  const draw = spreadsheet.sheet?.table?.draw;
  if (draw) {
    installTextZoom(draw, zoom);
    installHeaderFontZoom(draw, zoom);
  }
}

function installGridScale(data: ZoomData, zoom: SpreadsheetZoom): void {
  const cols = data.cols;
  const rows = data.rows;
  if (!cols || !rows) return;
  const tagged = cols as ZoomCols & { [GRID_FLAG]?: boolean };
  if (tagged[GRID_FLAG]) return;
  const baseWidth = cols.width;
  const baseIndex = cols.indexWidth;
  const baseHeight = rows.height;
  const rawSetWidth = cols.setWidth.bind(cols);
  const rawSetHeight = rows.setHeight.bind(rows);

  Object.defineProperty(cols, 'indexWidth', {
    configurable: true,
    get: () => baseIndex * scaleOf(zoom),
  });
  Object.defineProperty(rows, 'height', {
    configurable: true,
    get: () => baseHeight * scaleOf(zoom),
  });
  cols.getWidth = function getWidth(i: number) {
    if (this.isHide(i)) return 0;
    const col = this._[i];
    if (col && col.width) return col.width * scaleOf(zoom);
    return baseWidth * scaleOf(zoom);
  };
  cols.setWidth = function setWidth(i: number, width: number) {
    rawSetWidth(i, width / scaleOf(zoom));
  };
  rows.getHeight = function getHeight(i: number) {
    if (this.isHide(i)) return 0;
    const row = this.get(i);
    if (row && row.height) return row.height * scaleOf(zoom);
    return baseHeight * scaleOf(zoom);
  };
  rows.setHeight = function setHeight(i: number, height: number) {
    rawSetHeight(i, height / scaleOf(zoom));
  };
  tagged[GRID_FLAG] = true;
}

function installTextZoom(draw: XsDrawLike, zoom: SpreadsheetZoom): void {
  const tagged = draw as XsDrawLike & { [TEXT_FLAG]?: boolean };
  if (tagged[TEXT_FLAG] || typeof draw.text !== 'function') return;
  const original = draw.text.bind(draw);
  draw.text = (text, box, attr = {}, wrap) => {
    const font = attr.font;
    if (!font || typeof font !== 'object') return original(text, box, attr, wrap);
    const size = (font as { size?: number }).size;
    if (typeof size !== 'number') return original(text, box, attr, wrap);
    return original(text, box, { ...attr, font: { ...(font as object), size: size * scaleOf(zoom) } }, wrap);
  };
  tagged[TEXT_FLAG] = true;
}

function installHeaderFontZoom(draw: XsDrawLike, zoom: SpreadsheetZoom): void {
  const tagged = draw as XsDrawLike & { [HEADER_FLAG]?: boolean };
  if (tagged[HEADER_FLAG]) return;
  const original = draw.attr.bind(draw);
  draw.attr = (options) => {
    const next = { ...options };
    if (typeof next.font === 'string' && next.font.includes('Source Sans Pro')) {
      const scale = scaleOf(zoom);
      next.font = next.font.replace(/(\d+(?:\.\d+)?)px/, (_match, n: string) => `${Number(n) * scale}px`);
    }
    return original(next);
  };
  tagged[HEADER_FLAG] = true;
}

/**
 * Percent that fits the used columns (cells and their merges) into the viewport. Empty sheets stay at 100.
 * Explicit column widths do not count: Excel files often size every column up to XFD.
 */
export function fitZoomPercent(spreadsheet: XsSpreadsheetLike | null | undefined, viewportWidth: number, scale: number): number {
  const data = (spreadsheet?.sheet as { data?: ZoomData } | undefined)?.data
    ?? (Array.isArray(spreadsheet?.datas) ? spreadsheet?.datas[0] as ZoomData : undefined)
    ?? spreadsheet?.data as ZoomData | undefined;
  const cols = data?.cols;
  const rows = data?.rows;
  const current = scale > 0 ? scale : 1;
  if (!cols || !rows || viewportWidth <= 0) return 100;
  let maxCi = -1;
  for (const row of Object.values(rows._)) {
    const cells = row?.cells;
    if (!cells) continue;
    for (const key of Object.keys(cells)) {
      const index = Number(key);
      if (!Number.isFinite(index) || !cells[index]) continue;
      const span = Array.isArray(cells[index].merge) ? cells[index].merge[1] : 0;
      maxCi = Math.max(maxCi, index + span);
    }
  }
  if (maxCi < 0) return 100;
  let width = cols.indexWidth / current;
  for (let i = 0; i <= maxCi; i += 1) width += cols.getWidth(i) / current;
  if (width <= 0) return 100;
  return clampZoom((viewportWidth / width) * 100);
}
