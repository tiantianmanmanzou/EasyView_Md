import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { PNG } from 'pngjs';
import { flattenPngWithWhiteBackground, rewriteExtractedMediaPaths } from './wordToMarkdown';
import { stripPandocHighlightMarkup } from '@easyview/markdown-core/pandoc-highlight-markup';

describe('rewriteExtractedMediaPaths', () => {
  it('replaces Pandoc temporary image paths with portable asset references', () => {
    const output = rewriteExtractedMediaPaths(
      '<img src="/tmp/easyview-word-123/media/media/image1.png" />\n![](/tmp/easyview-word-123/media/media/image2.jpg)',
      '/tmp/easyview-word-123/media/media',
      '方案.assets',
    );

    expect(output).toContain('./方案.assets/image1.png');
    expect(output).toContain('./方案.assets/image2.jpg');
    expect(output).not.toContain('/tmp/easyview-word-123');
  });

  it('also rewrites file URI media paths', () => {
    const output = rewriteExtractedMediaPaths(
      '<img src="file:///tmp/easyview-word-123/media/media/image1.png" />',
      '/tmp/easyview-word-123/media/media',
      'document.assets',
    );

    expect(output).toContain('./document.assets/image1.png');
    expect(output).not.toContain('file://');
  });

  it('converts Pandoc HTML images into native Markdown images while preserving Word dimensions', () => {
    const output = rewriteExtractedMediaPaths(
      '<img src="/tmp/easyview-word-123/media/media/image1.png" style="width:6.29306in;height:3.83194in" alt="图片 &amp; 示例" />',
      '/tmp/easyview-word-123/media/media',
      '技术规范书.assets',
    );

    expect(output).toBe('![图片 & 示例](./技术规范书.assets/image1.png){width=6.29306in height=3.83194in}');
    expect(output).not.toContain('<img');
  });

  it('uses angle brackets for image paths with spaces', () => {
    const output = rewriteExtractedMediaPaths(
      '<img alt="diagram" src="/tmp/easyview-word-123/media/media/flow chart.png" width="400" />',
      '/tmp/easyview-word-123/media/media',
      'document.assets',
    );

    expect(output).toBe('![diagram](<./document.assets/flow chart.png>){width=400}');
  });
});

describe('stripPandocHighlightMarkup', () => {
  it('unwraps Word highlighter spans in headings', () => {
    expect(stripPandocHighlightMarkup('## <span class="mark">数据安全管控</span>')).toBe('## 数据安全管控');
    expect(stripPandocHighlightMarkup('#### <span class="mark">数据资源一致性稽核</span>')).toBe(
      '#### 数据资源一致性稽核',
    );
  });

  it('unwraps highlighter spans inside other Markdown marks', () => {
    expect(stripPandocHighlightMarkup('1.  **<span class="mark">业务系统管理</span>**')).toBe(
      '1.  **业务系统管理**',
    );
  });

  it('drops empty highlighter tags that would otherwise become HTML blocks', () => {
    expect(
      stripPandocHighlightMarkup('## <span class="mark">\n</span>\n'),
    ).toBe('## \n');
  });

  it('unwraps nested highlighter tags and <mark> elements', () => {
    expect(
      stripPandocHighlightMarkup('<span class="mark"><span class="mark">标题</span></span>'),
    ).toBe('标题');
    expect(stripPandocHighlightMarkup('<mark class="mark">重点</mark>')).toBe('重点');
  });

  it('unwraps highlighter spans that wrap other inline HTML', () => {
    expect(
      stripPandocHighlightMarkup('## <span class="mark"><em>数据安全管控</em></span>'),
    ).toBe('## <em>数据安全管控</em>');
  });

  it('leaves unrelated spans unchanged', () => {
    expect(stripPandocHighlightMarkup('<span class="underline">保留</span>')).toBe(
      '<span class="underline">保留</span>',
    );
  });
});

describe('flattenPngWithWhiteBackground', () => {
  it('flattens transparent PNG pixels against a white background', () => {
    const source = new PNG({ width: 2, height: 1 });
    source.data.set([
      255, 0, 0, 128, // half-transparent red over white
      0, 0, 0, 0, // fully transparent becomes white
    ]);

    const flattened = flattenPngWithWhiteBackground(PNG.sync.write(source));
    const result = PNG.sync.read(flattened);
    expect([...result.data]).toEqual([
      255, 127, 127, 255,
      255, 255, 255, 255,
    ]);
    // PNG IHDR color type 2 is RGB and does not retain a transparent alpha channel.
    expect(flattened[25]).toBe(2);
  });

  it('leaves opaque PNG data untouched', () => {
    const source = new PNG({ width: 1, height: 1 });
    source.data.set([12, 34, 56, 255]);
    const encoded = PNG.sync.write(source);

    expect(flattenPngWithWhiteBackground(encoded)).toEqual(encoded);
  });
});
