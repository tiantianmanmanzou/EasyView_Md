import { describe, expect, it, vi } from 'vitest';
import type { XsSpreadsheetLike } from './xSpreadsheetTypes';
import {
  bindSpreadsheetZoom,
  clampZoom,
  fitZoomPercent,
  refreshSpreadsheetAfterZoom,
  zoomChoices,
  zoomPercentAfterWheel,
} from './spreadsheetZoom';

describe('spreadsheet zoom', () => {
  it('scales grid metrics for paint and stores unscaled sizes on resize', () => {
    const cols = {
      width: 100,
      indexWidth: 60,
      _: { 0: { width: 229 } } as Record<number, { width?: number }>,
      isHide: () => false,
      getWidth(i: number) {
        const col = this._[i];
        return col?.width ?? this.width;
      },
      setWidth(i: number, width: number) {
        this._[i] = { width };
      },
    };
    const rows = {
      height: 25,
      _: { 0: { height: 34, cells: { 0: { text: '标题', merge: [0, 5] as [number, number] } } } } as Record<number, { height?: number; cells?: Record<number, { text?: string; merge?: [number, number] }> }>,
      isHide: () => false,
      get(i: number) { return this._[i]; },
      getHeight(i: number) {
        const row = this.get(i);
        return row?.height ?? this.height;
      },
      setHeight(i: number, height: number) {
        this._[i] = { ...this._[i], height };
      },
    };
    const fonts: number[] = [];
    const headerFonts: string[] = [];
    const draw = {
      attr(options: Record<string, unknown>) {
        if (typeof options.font === 'string') headerFonts.push(options.font);
        return this;
      },
      text(_text: string, _box: unknown, attr?: Record<string, unknown>) {
        const font = attr?.font as { size?: number } | undefined;
        if (typeof font?.size === 'number') fonts.push(font.size);
        return this;
      },
    };
    const zoom = { scale: 0.85 };
    const spreadsheet = { datas: [{ cols, rows }], sheet: { table: { draw } } } as unknown as XsSpreadsheetLike;
    bindSpreadsheetZoom(spreadsheet, zoom);

    expect(cols.getWidth(0)).toBeCloseTo(229 * 0.85);
    expect(cols.getWidth(3)).toBeCloseTo(100 * 0.85);
    expect(cols.indexWidth).toBeCloseTo(60 * 0.85);
    expect(rows.getHeight(0)).toBeCloseTo(34 * 0.85);
    expect(rows.getHeight(2)).toBeCloseTo(25 * 0.85);
    expect(rows.height).toBeCloseTo(25 * 0.85);
    expect(fitZoomPercent(spreadsheet, 60 + 229 + 100 * 5, zoom.scale)).toBe(100);
    // Excel often sizes every column up to XFD; only columns holding cells count.
    for (let i = 1; i < 16384; i += 1) cols._[i] = { width: 100 };
    expect(fitZoomPercent(spreadsheet, 60 + 229 + 100 * 5, zoom.scale)).toBe(100);
    for (let i = 1; i < 16384; i += 1) delete cols._[i];

    cols.setWidth(0, 200);
    expect(cols._[0]?.width).toBeCloseTo(200 / 0.85);
    expect(cols.getWidth(0)).toBeCloseTo(200);

    draw.text('标题', {}, { font: { size: 26.666 } });
    expect(fonts[0]).toBeCloseTo(26.666 * 0.85);
    draw.attr({ font: '500 12px Source Sans Pro' });
    expect(headerFonts[0]).toBe('500 10.2px Source Sans Pro');
    expect(clampZoom(8)).toBe(10);
    expect(zoomChoices(85)).toContain(85);
  });

  it('maps trackpad pinch deltas onto zoom percent', () => {
    expect(zoomPercentAfterWheel(100, 0)).toBe(100);
    expect(zoomPercentAfterWheel(100, 100)).toBeLessThan(100);
    expect(zoomPercentAfterWheel(100, -100)).toBeGreaterThan(100);
    expect(zoomPercentAfterWheel(10, 500)).toBe(10);
    expect(zoomPercentAfterWheel(400, -500)).toBe(400);
  });

  it('reloads the sheet after zoom so the selection overlay rematches the grid', () => {
    const reload = vi.fn();
    const reRender = vi.fn();
    const resetAreaOffset = vi.fn();
    refreshSpreadsheetAfterZoom({ sheet: { reload }, reRender } as XsSpreadsheetLike);
    expect(reload).toHaveBeenCalled();
    expect(reRender).not.toHaveBeenCalled();

    refreshSpreadsheetAfterZoom({
      reRender,
      sheet: { selector: { hideClipboard() {}, resetAreaOffset } },
    } as XsSpreadsheetLike);
    expect(reRender).toHaveBeenCalled();
    expect(resetAreaOffset).toHaveBeenCalled();
  });
});
