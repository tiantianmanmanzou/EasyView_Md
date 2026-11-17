import { describe, expect, it, vi } from 'vitest';
import { patchSpreadsheetSelector } from './spreadsheetSelector';

describe('patchSpreadsheetSelector', () => {
  it('sets the cell rect as border-box size (no inward shrink)', () => {
    const applied: Array<Record<string, number>> = [];
    const areaEl = {
      el: { style: {} as CSSStyleDeclaration },
      css: vi.fn(),
      offset(value: Record<string, number>) {
        applied.push(value);
        return this;
      },
      show() { return this; },
    };
    const br = {
      useHideInput: true,
      areaEl,
      hideInputDiv: { offset: vi.fn(function offset(this: unknown) { return this; }) },
      hideInput: { val: vi.fn(() => ({ focus: vi.fn() })) },
      setAreaOffset() { /* replaced by patch */ },
    };
    patchSpreadsheetSelector({ selector: { br } } as never);
    (br.setAreaOffset as (offset: Record<string, number>) => void)({ left: 10, top: 20, width: 100, height: 25 });
    expect(applied).toEqual([{ left: 10, top: 20, width: 100, height: 25 }]);
    expect(areaEl.css).toHaveBeenCalledWith('box-sizing', 'border-box');
    expect(areaEl.el.style.boxSizing).toBe('border-box');
    expect(br.hideInputDiv.offset).toHaveBeenCalledWith({ left: 10, top: 20, width: 100, height: 25 });
  });

  it('is idempotent', () => {
    const br = {
      areaEl: { offset: vi.fn(function offset(this: unknown) { return this; }), show: vi.fn(function show(this: unknown) { return this; }) },
      setAreaOffset: vi.fn(),
    };
    const sheet = { selector: { br } };
    patchSpreadsheetSelector(sheet as never);
    const first = br.setAreaOffset;
    patchSpreadsheetSelector(sheet as never);
    expect(br.setAreaOffset).toBe(first);
  });
});
