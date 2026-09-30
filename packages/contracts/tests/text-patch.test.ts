import { describe, expect, it } from 'vitest';
import { applyAiTextPatches } from '../src/ai/text-patch';

describe('applyAiTextPatches', () => {
  it('applies independent exact patches atomically', () => {
    expect(applyAiTextPatches('# Title\n\nFirst\n\nLast\n', [
      { description: 'Append a note', expectedText: 'Last\n', replacement: 'Last\nAppended\n' },
      { description: 'Rename heading', expectedText: '# Title', replacement: '# Updated' },
    ])).toBe('# Updated\n\nFirst\n\nLast\nAppended\n');
  });

  it('rejects missing, ambiguous, and overlapping anchors', () => {
    expect(() => applyAiTextPatches('same\nsame\n', [{ description: 'x', expectedText: 'same', replacement: 'next' }])).toThrow('匹配多处');
    expect(() => applyAiTextPatches('abc', [{ description: 'x', expectedText: 'missing', replacement: '' }])).toThrow('未匹配');
  });
});
