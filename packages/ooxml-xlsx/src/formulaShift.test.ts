import { describe, expect, it } from 'vitest';
import { shiftFormulaRows } from './formulaShift';

describe('shiftFormulaRows', () => {
  it('shifts relative rows on insert and leaves absolute rows alone', () => {
    expect(shiftFormulaRows('A2+B$2+C10', 2, 0, 1)).toBe('A3+B$2+C11');
  });

  it('marks deleted-range refs as #REF! and shifts rows below', () => {
    expect(shiftFormulaRows('A2+A5', 2, 2, 0)).toBe('#REF!+A3');
  });

  it('preserves operators and sheet-qualified refs', () => {
    expect(shiftFormulaRows("SUM(A2,Sheet1!B3)+'My Sheet'!C4", 3, 0, 2)).toBe(
      "SUM(A2,Sheet1!B5)+'My Sheet'!C6",
    );
  });
});
