import { describe, expect, it } from 'vitest';
import { wheelEventToPixels } from '../src/spreadsheet/spreadsheetWheel';

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
