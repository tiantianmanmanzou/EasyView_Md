/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { attachSpreadsheetWheelNormalization, wheelEventToPixels } from './spreadsheetWheel';

function wheel(partial: Partial<WheelEvent>): WheelEvent {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    ...partial,
  } as WheelEvent;
}

describe('wheelEventToPixels', () => {
  it('keeps pixel-mode deltas as-is', () => {
    expect(wheelEventToPixels(wheel({ deltaY: 12, deltaX: -3 }))).toEqual({ dx: -3, dy: 12 });
  });

  it('scales line-mode deltas', () => {
    expect(wheelEventToPixels(wheel({ deltaY: 1, deltaMode: 1 }))).toEqual({ dx: 0, dy: 32 });
  });

  it('maps shift+vertical wheel to horizontal', () => {
    expect(wheelEventToPixels(wheel({ deltaY: 40, shiftKey: true }))).toEqual({ dx: 40, dy: 0 });
  });
});

describe('attachSpreadsheetWheelNormalization pinch zoom', () => {
  it('routes ctrl+wheel to onZoomDelta instead of scrolling', () => {
    const mount = document.createElement('div');
    const sheet = document.createElement('div');
    sheet.className = 'x-spreadsheet';
    const overlayer = document.createElement('div');
    overlayer.className = 'x-spreadsheet-overlayer';
    const vertical = document.createElement('div');
    vertical.className = 'x-spreadsheet-scrollbar vertical';
    Object.defineProperty(vertical, 'scrollTop', { value: 0, writable: true });
    sheet.append(overlayer, vertical);
    mount.append(sheet);
    document.body.append(mount);
    const zooms: number[] = [];
    const dispose = attachSpreadsheetWheelNormalization(mount, { onZoomDelta: (d) => zooms.push(d) });
    // happy-dom may ignore WheelEventInit.ctrlKey; force it on the instance.
    const evt = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'ctrlKey', { value: true });
    overlayer.dispatchEvent(evt);
    expect(zooms).toEqual([40]);
    expect(vertical.scrollTop).toBe(0);
    dispose();
    mount.remove();
  });
});
