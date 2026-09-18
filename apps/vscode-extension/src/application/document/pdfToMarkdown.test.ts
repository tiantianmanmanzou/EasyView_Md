import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { markdownImageReferences, pdfTextToMarkdown } from './pdfToMarkdown';

describe('pdfTextToMarkdown', () => {
  it('keeps PDF text editable and marks page breaks', () => {
    expect(pdfTextToMarkdown('First page  \r\n\r\n\fSecond page\u0000')).toBe('First page\n\n---\n\nSecond page');
  });

  it('removes repeated empty lines and non-printing control characters', () => {
    expect(pdfTextToMarkdown('A\n\n\n\nB\u0007')).toBe('A\n\nB');
  });
});

describe('markdownImageReferences', () => {
  it('uses portable asset references ordered by natural filename order', () => {
    expect(markdownImageReferences('Example.assets', [
      '/tmp/page-10.png',
      '/tmp/page-2.png',
    ])).toBe('![](./Example.assets/page-2.png)\n\n![](./Example.assets/page-10.png)');
  });
});
