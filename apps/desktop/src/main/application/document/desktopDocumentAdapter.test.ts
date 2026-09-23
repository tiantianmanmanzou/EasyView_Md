import { describe, expect, it } from 'vitest';
import { DesktopDocumentAdapter } from './desktopDocumentAdapter';

 describe('DesktopDocumentAdapter', () => {
  it('keeps legacy settings and CRLF while applying canonical UTF-16 patches', () => {
    const adapter = new DesktopDocumentAdapter('<!-- fullWidth: true -->\r\n你好😀\r\n');
    expect(adapter.content).toBe('你好😀\n');
    const result = adapter.apply([{ from: 2, to: 4, insert: '世界' }]);
    expect(result.canonicalContent).toBe('你好世界\n');
    expect(result.rawContent).toBe('<!-- fullWidth: true -->\r\n你好世界\r\n');
  });

  it('rebuilds the canonical view when the watcher reads a new raw file', () => {
    const adapter = new DesktopDocumentAdapter('a\n');
    const result = adapter.replaceRaw('<!-- fullWidth: false tocVisible: false -->\r\nb\r\n');
    expect(adapter.content).toBe('b\n');
    expect(result.rawContent).toBe('<!-- fullWidth: false tocVisible: false -->\r\nb\r\n');
  });
});
