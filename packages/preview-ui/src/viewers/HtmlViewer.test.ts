import { describe, expect, it } from 'vitest';
import {
  htmlDocumentWithBase,
  htmlPreviewBaseHref,
  htmlRewriteRelativeUrls,
  isHtmlPreviewAssetHref,
  isLocalHttpPreviewUrl,
} from './HtmlViewer';

describe('html preview document', () => {
  it('turns a page URL into a directory base href', () => {
    expect(htmlPreviewBaseHref('easyview-preview://content/11111111-1111-4111-8111-111111111111/page.html'))
      .toBe('easyview-preview://content/11111111-1111-4111-8111-111111111111/');
    expect(htmlPreviewBaseHref('https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/index.html'))
      .toBe('https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/');
  });

  it('injects base and iframe proxy bootstrap without rewriting page styles', () => {
    const html = htmlDocumentWithBase(
      '<html><head><title>Demo</title></head><body><h1>Hi</h1></body></html>',
      'easyview-preview://content/id/',
    );
    expect(html).toContain('<base href="easyview-preview://content/id/">');
    expect(html).toContain('easyview-html');
    expect(html).toContain('reportReady');
    expect(html).toContain('postToHost');
    expect(html).toContain('HTMLIFrameElement');
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toContain('!important');
  });

  it('rewrites relative iframe and script urls against the page directory', () => {
    const html = htmlRewriteRelativeUrls(
      '<iframe src="dsmp/page.html"></iframe><script src="nav.js"></script>',
      'https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/',
    );
    expect(html).toContain('https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/dsmp/page.html');
    expect(html).toContain('https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/nav.js');
  });

  it('detects local http preview URLs', () => {
    expect(isLocalHttpPreviewUrl('http://127.0.0.1:4123/token/page.html')).toBe(true);
    expect(isLocalHttpPreviewUrl('https://file+.vscode-resource.vscode-cdn.net/tmp/page.html')).toBe(false);
  });

  it('only allows sibling fetches on the same preview origin', () => {
    const contentUrl = 'https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/index.html';
    expect(isHtmlPreviewAssetHref('https://file+.vscode-resource.vscode-cdn.net/Users/demo/site/dsmp/a.html', contentUrl)).toBe(true);
    expect(isHtmlPreviewAssetHref('https://example.com/dsmp/a.html', contentUrl)).toBe(false);
  });
});
