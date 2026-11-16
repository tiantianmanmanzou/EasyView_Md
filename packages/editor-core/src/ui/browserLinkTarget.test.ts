/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { browserLinkFromEvent, urlInText } from './browserLinkTarget';

describe('browser link target', () => {
  it('reads an http link from Markdown and from a code line', () => {
    expect(urlInText('see https://example.com/a.', 4)).toBe('https://example.com/a');
    expect(urlInText('https://one.test and https://two.test', null)).toBeNull();
    expect(urlInText('only https://only.test here', null)).toBe('https://only.test');

    document.body.innerHTML = '<div id="editor"><a href="https://example.com/docs">docs</a><pre><code>curl https://api.example.com/v1</code></pre></div>';
    const anchor = document.querySelector('a')!;
    expect(browserLinkFromEvent({ target: anchor })).toBe('https://example.com/docs');
    const code = document.querySelector('code')!;
    expect(browserLinkFromEvent({ target: code })).toBe('https://api.example.com/v1');
    expect(browserLinkFromEvent({ target: document.getElementById('editor') })).toBeNull();
  });

  it('ignores non-http schemes', () => {
    document.body.innerHTML = '<a href="javascript:alert(1)">x</a>';
    expect(browserLinkFromEvent({ target: document.querySelector('a') })).toBeNull();
  });
});
