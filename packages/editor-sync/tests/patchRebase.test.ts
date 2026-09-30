import { describe, expect, it } from 'vitest';
import { rebasePatches } from '../patchRebase';

describe('patch rebase', () => {
  it('shifts a non-overlapping patch after an insertion', () => {
    expect(rebasePatches([{ from: 4, to: 5, insert: 'X' }], [{ from: 1, to: 1, insert: 'abc' }])).toEqual({
      conflict: false,
      patches: [{ from: 7, to: 8, insert: 'X' }],
    });
  });

  it('reports overlapping changes as conflict', () => {
    expect(rebasePatches([{ from: 2, to: 4, insert: 'X' }], [{ from: 3, to: 5, insert: 'Y' }])).toEqual({ conflict: true, patches: [] });
  });
});
