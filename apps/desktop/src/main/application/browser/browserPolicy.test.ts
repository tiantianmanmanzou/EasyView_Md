import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  browserShortcutCommand,
  browserTabFileName,
  browserWebPreferences,
  decideBrowserPopup,
  downloadRoute,
  isLocalHtmlPath,
  parseBrowserAddress,
  scaleBrowserBounds,
  shouldShowBrowserView,
  uniqueDownloadName,
} from './browserPolicy';

describe('browser policy', () => {
  it('keeps the guest session sandboxed, without Node, preload, or DevTools', () => {
    const preferences = browserWebPreferences();
    expect(preferences).toMatchObject({
      partition: 'persist:easyview-browser',
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
    });
    expect(preferences.preload).toBeUndefined();
  });

  it('accepts http(s), file URLs, bare hosts, and local paths', () => {
    expect(parseBrowserAddress('  Example.COM/docs  ')).toEqual({ kind: 'url', url: 'https://Example.COM/docs' });
    expect(parseBrowserAddress('https://easyview.dev')).toEqual({ kind: 'url', url: 'https://easyview.dev/' });
    expect(parseBrowserAddress('about:blank')).toEqual({ kind: 'url', url: 'about:blank' });
    expect(parseBrowserAddress('/tmp/page.html')).toEqual({ kind: 'path', path: '/tmp/page.html' });
    expect(parseBrowserAddress('javascript:alert(1)')).toBeNull();
    expect(parseBrowserAddress('data:text/html,hi')).toBeNull();
  });

  it('opens guest windows as a new tab, or reuses the current tab', () => {
    expect(decideBrowserPopup({ url: 'https://example.com/a', disposition: 'new-window' })).toEqual({ action: 'new-tab', url: 'https://example.com/a' });
    expect(decideBrowserPopup({ url: 'https://example.com/a', disposition: 'foreground-tab' }).action).toBe('new-tab');
    expect(decideBrowserPopup({ url: 'https://example.com/a', disposition: 'default' })).toEqual({ action: 'reuse', url: 'https://example.com/a' });
    expect(decideBrowserPopup({ url: 'https://example.com/file.zip', disposition: 'save-to-disk' })).toEqual({ action: 'download', url: 'https://example.com/file.zip' });
    expect(decideBrowserPopup({ url: 'javascript:alert(1)', disposition: 'new-window' })).toEqual({ action: 'deny' });
  });

  it('scales renderer CSS pixels into window DIP and hides a covered or empty slot', () => {
    expect(scaleBrowserBounds({ x: 10, y: 20, width: 100, height: 50 }, 1.2)).toEqual({ x: 12, y: 24, width: 120, height: 60 });
    expect(shouldShowBrowserView({ obscured: false, bounds: { x: 0, y: 0, width: 40, height: 40 } })).toBe(true);
    expect(shouldShowBrowserView({ obscured: true, bounds: { x: 0, y: 0, width: 40, height: 40 } })).toBe(false);
    expect(shouldShowBrowserView({ obscured: false, bounds: null })).toBe(false);
    expect(shouldShowBrowserView({ obscured: false, bounds: { x: 0, y: 0, width: 1, height: 40 } })).toBe(false);
  });

  it('names tabs from the page title, then the file or host', () => {
    expect(browserTabFileName('about:blank', '', '新标签页')).toBe('新标签页');
    expect(browserTabFileName('file:///tmp/notes.html', '', '新标签页')).toBe('notes.html');
    expect(browserTabFileName('https://example.com/docs', 'Example', '新标签页')).toBe('Example');
    expect(isLocalHtmlPath('/tmp/Page.HTML')).toBe(true);
    expect(isLocalHtmlPath('/tmp/page.md')).toBe(false);
  });

  it('sends downloads to a save dialog or a unique file in Downloads', () => {
    const taken = new Set(['report.pdf']);
    expect(uniqueDownloadName('report.pdf', (name) => taken.has(name))).toBe('report (1).pdf');
    const join = (directory: string, name: string) => path.join(directory, name);
    expect(downloadRoute({
      preferDialog: true,
      directory: '/downloads',
      filename: 'report.pdf',
      taken: () => false,
      join,
    })).toEqual({ kind: 'dialog', defaultPath: path.join('/downloads', 'report.pdf') });
    expect(downloadRoute({
      preferDialog: false,
      directory: '/downloads',
      filename: 'report.pdf',
      taken: (name) => name === 'report.pdf',
      join,
    })).toEqual({ kind: 'file', savePath: path.join('/downloads', 'report (1).pdf') });
  });

  it('recognizes the browser and command-palette shortcuts from the guest', () => {
    expect(browserShortcutCommand({ key: 'b', meta: true, control: false, shift: true, alt: false })).toBe('openBrowser');
    expect(browserShortcutCommand({ key: 'p', meta: false, control: true, shift: true, alt: false })).toBe('openCommandPalette');
    expect(browserShortcutCommand({ key: 'b', meta: true, control: false, shift: false, alt: false })).toBeNull();
  });
});
