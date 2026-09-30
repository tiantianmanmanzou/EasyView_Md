// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sanitizeHtmlBlockForEditor } from './HtmlBlockExtension';

describe('sanitizeHtmlBlockForEditor', () => {
  it('keeps presentation HTML while removing executable content', () => {
    const result = sanitizeHtmlBlockForEditor(
      '<details><summary>Open</summary><strong onclick="alert(1)">Text</strong></details>'
        + '<script>alert(1)</script><a href="javascript:alert(1)">link</a>',
    );

    expect(result).toContain('<details>');
    expect(result).toContain('<strong>Text</strong>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('onclick');
    expect(result).not.toContain('javascript:');
  });
});
