import { describe, expect, it } from 'vitest';
import { createCanonicalDocument } from '../canonicalDocument';

describe('CanonicalDocument', () => {
  it('normalizes CRLF, strips legacy settings, and maps UTF-16 offsets', () => {
    const raw = '<!-- fullWidth: true tocVisible: false -->\r\n标题 😀\r\n正文';
    const document = createCanonicalDocument(raw);

    expect(document.content).toBe('标题 😀\n正文');
    expect(document.eol).toBe('\r\n');
    expect(document.strippedSettingsRange).toEqual({ from: 0, to: 44 });
    expect(document.canonicalToRawOffset(0)).toBe(44);
    expect(document.canonicalToRawOffset(4)).toBe(48);
    expect(document.rawToCanonicalOffset(44)).toBe(0);
    expect(document.canonicalToRawRange({ from: 0, to: 2 })).toEqual({ from: 44, to: 46 });
  });

  it('preserves raw content and maps CRLF line endings without counting CR', () => {
    const document = createCanonicalDocument('a\r\nb\r\nc');
    expect(document.rawContent).toBe('a\r\nb\r\nc');
    expect(document.content).toBe('a\nb\nc');
    expect(document.canonicalToRawOffset(2)).toBe(3);
    expect(document.canonicalToRawOffset(4)).toBe(6);
  });
});

it('serializes canonical content using the original EOL and preserves the settings prefix', () => {
  const document = createCanonicalDocument('<!-- fullWidth: true -->\r\nfirst\r\nsecond');
  expect(document.toRawContent('first\nupdated')).toBe('<!-- fullWidth: true -->\r\nfirst\r\nupdated');
});
