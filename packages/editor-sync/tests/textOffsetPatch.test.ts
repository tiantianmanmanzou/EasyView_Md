import { describe, expect, it } from 'vitest';
import { applyTextPatches, minimalTextPatch, TextPatchError, validatePatches } from '../textOffsetPatch';

describe('TextOffsetPatch', () => {
  it('applies patches from right to left and produces a minimal replacement', () => {
    const patches = [{ from: 1, to: 2, insert: 'X' }, { from: 4, to: 5, insert: 'Y' }];
    expect(applyTextPatches('abcdE', patches)).toBe('aXcdY');
    expect(minimalTextPatch('hello world', 'hello brave world')).toEqual([{ from: 6, to: 6, insert: 'brave ' }]);
  });

  it('rejects out of bounds and overlapping patches', () => {
    expect(() => validatePatches([{ from: 0, to: 2, insert: '' }, { from: 1, to: 3, insert: '' }], 3)).toThrow(TextPatchError);
    expect(() => applyTextPatches('abc', [{ from: 0, to: 4, insert: '' }])).toThrow(TextPatchError);
  });

  it('uses UTF-16 offsets for astral characters', () => {
    expect(applyTextPatches('😀x', [{ from: 2, to: 3, insert: 'y' }])).toBe('😀y');
  });
});
