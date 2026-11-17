import { describe, expect, it } from 'vitest';
import {
  adaptCellStyleForTheme,
  applyXSpreadsheetTheme,
  fontSizeForCanvas,
  isThemeableBackground,
  isThemeableForeground,
  spreadsheetDefaultStyle,
} from './spreadsheetTheme';

describe('spreadsheetTheme', () => {
  it('classifies near-white/black as themeable and keeps vivid fills', () => {
    expect(isThemeableBackground('#ffffff')).toBe(true);
    expect(isThemeableBackground('#fff')).toBe(true);
    expect(isThemeableBackground('#f4f5f8')).toBe(true);
    expect(isThemeableBackground('#deebf7')).toBe(false);
    expect(isThemeableBackground('#ddebf7')).toBe(false);
    expect(isThemeableBackground('#00b050')).toBe(false);
    expect(isThemeableBackground('#ffff00')).toBe(false);
    expect(isThemeableForeground('#000000')).toBe(true);
    expect(isThemeableForeground('#0a0a0a')).toBe(true);
    expect(isThemeableForeground('#c00000')).toBe(false);
  });

  it('adapts neutral cell styles per EasyView theme without touching green fills', () => {
    const dark = adaptCellStyleForTheme({ bgcolor: '#ffffff', color: '#000000', font: { bold: true } }, 'dark');
    expect(dark.bgcolor).toBe('#1e1e1e');
    expect(dark.color).toBe('#d4d4d4');

    const kept = adaptCellStyleForTheme({ bgcolor: '#00b050', color: '#000000' }, 'dark');
    expect(kept.bgcolor).toBe('#00b050');
    expect(kept.color).toBe('#d4d4d4');
  });

  it('updates default style and re-renders the spreadsheet instance', () => {
    let rendered = 0;
    const data = {
      settings: { style: { bgcolor: '#ffffff', color: '#0a0a0a' } },
      getCellStyleOrDefault: (_ri: number, _ci: number) => ({ bgcolor: '#ffffff', color: '#0a0a0a' }),
    };
    const drawCalls: Array<Record<string, unknown>> = [];
    const draw = {
      attr(options: Record<string, unknown>) {
        drawCalls.push(options);
        return this;
      },
    };
    const spreadsheet = {
      datas: [data],
      sheet: { table: { draw } },
      reRender: () => { rendered += 1; },
    };

    applyXSpreadsheetTheme(spreadsheet, 'dark');
    expect(spreadsheetDefaultStyle('dark')).toEqual({ bgcolor: '#1e1e1e', color: '#d4d4d4' });
    expect(data.settings.style.bgcolor).toBe('#1e1e1e');
    expect(data.settings.style.color).toBe('#d4d4d4');
    expect(data.getCellStyleOrDefault(0, 0)).toEqual({ bgcolor: '#1e1e1e', color: '#d4d4d4' });
    expect(rendered).toBe(1);

    draw.attr({ fillStyle: '#f4f5f8' });
    draw.attr({ fillStyle: '#585757', strokeStyle: '#e6e6e6' });
    expect(drawCalls[0]?.fillStyle).toBe('#2d2d2d');
    expect(drawCalls[1]?.fillStyle).toBe('#d4d4d4');
    expect(drawCalls[1]?.strokeStyle).toBe('#3c3c3c');
  });

  it('draws unmapped point sizes as pixels and keeps the toolbar value in points', () => {
    expect(fontSizeForCanvas(20)).toBeCloseTo(20 * 96 / 72);
    expect(fontSizeForCanvas(10)).toBe(10);
    const data = {
      selector: { ri: 0, ci: 0 },
      getCellStyleOrDefault: (_ri: number, _ci: number) => ({ font: { name: '宋体-简', size: 20, bold: true }, bgcolor: '#deebf7' }),
      getSelectedCellStyle: () => ({ font: { name: '宋体-简', size: 20, bold: true }, bgcolor: '#deebf7' }),
    };
    applyXSpreadsheetTheme({ datas: [data], reRender: () => undefined }, 'light');
    const drawn = data.getCellStyleOrDefault(0, 0);
    expect(drawn.bgcolor).toBe('#deebf7');
    expect((drawn.font as { size: number }).size).toBeCloseTo(20 * 96 / 72);
    expect((drawn.font as { name: string }).name).toContain('Songti SC');
    const selected = data.getSelectedCellStyle();
    expect((selected.font as { size: number }).size).toBe(20);
    expect((selected.font as { name: string }).name).toBe('宋体-简');
  });
});
