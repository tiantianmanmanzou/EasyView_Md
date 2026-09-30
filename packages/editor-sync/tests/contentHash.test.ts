import { describe, expect, it } from 'vitest';
import { hashContent } from '../contentHash';

describe('content hash', () => {
  it('is stable and distinguishes content', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
    expect(hashContent('')).toBe('cbf29ce484222325');
  });
});
