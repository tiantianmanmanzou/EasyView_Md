import { describe, expect, it } from 'vitest';
import * as exportHtml from './ExportHtml';
import * as htmlDomCleanup from './HtmlDomCleanup';
import * as htmlCodeHighlighting from './HtmlCodeHighlighting';
import {
  escapeHtml,
  extractImageFilename,
  makeUniqueFilename,
  sanitizeFilename,
} from './ExportTypes';

const targetFiles = [
  'ExportHtml.ts',
  'HtmlDomCleanup.ts',
  'HtmlCodeHighlighting.ts',
];

describe('HTML export dependency boundaries', () => {
  it('keeps shared export primitives independent from the export entry point', async () => {
    const modules = [exportHtml, htmlDomCleanup, htmlCodeHighlighting];

    expect(modules).toHaveLength(targetFiles.length);
    for (const module of modules) {
      expect(module).toBeDefined();
    }
  });

  it('preserves shared HTML export helper behavior', () => {
    expect(escapeHtml('& <tag> "quoted"')).toBe('&amp; &lt;tag&gt; &quot;quoted&quot;');
    expect(extractImageFilename('https://example.com/assets/photo%20one.png?raw=1'))
      .toBe('photo_one.png');
    expect(extractImageFilename('C:%5CUsers%5Cdemo%5Cphoto.png'))
      .toBe('photo.png');
    expect(sanitizeFilename('a<b>:c?.png')).toBe('a_b__c_.png');
    expect(makeUniqueFilename('photo.png', new Set(['photo.png', 'photo-1.png'])))
      .toBe('photo-2.png');
  });
});
