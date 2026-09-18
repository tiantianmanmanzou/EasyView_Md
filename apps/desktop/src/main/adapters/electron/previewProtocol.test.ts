import { describe, expect, it } from 'vitest';
import { parseByteRange } from './previewProtocol';

describe('parseByteRange', () => {
  it('supports bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
  });

  it('rejects multiple, reversed, and out-of-bounds ranges', () => {
    expect(parseByteRange('bytes=1-2,4-5', 100)).toBe('invalid');
    expect(parseByteRange('bytes=20-10', 100)).toBe('invalid');
    expect(parseByteRange('bytes=100-', 100)).toBe('invalid');
    expect(parseByteRange('items=0-1', 100)).toBe('invalid');
  });
});
