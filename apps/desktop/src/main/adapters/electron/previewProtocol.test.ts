import { describe, expect, it } from 'vitest';
import { parseByteRange, parsePreviewContentPath } from './previewProtocol';

describe('parsePreviewContentPath', () => {
  it('splits a session id and optional relative HTML asset', () => {
    expect(parsePreviewContentPath('/11111111-1111-4111-8111-111111111111')).toEqual({
      contentId: '11111111-1111-4111-8111-111111111111',
      assetPath: '',
    });
    expect(parsePreviewContentPath('/11111111-1111-4111-8111-111111111111/style.css')).toEqual({
      contentId: '11111111-1111-4111-8111-111111111111',
      assetPath: 'style.css',
    });
    expect(parsePreviewContentPath('/11111111-1111-4111-8111-111111111111/dsmp/page/%E5%BA%93.html')).toEqual({
      contentId: '11111111-1111-4111-8111-111111111111',
      assetPath: 'dsmp/page/库.html',
    });
    expect(parsePreviewContentPath('/not-a-session/style.css')).toBeNull();
  });
});

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
