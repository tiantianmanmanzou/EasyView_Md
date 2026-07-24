import { describe, expect, it } from 'vitest';
import {
  replaceBareImageDataUri,
  replaceHtmlImageDataUris,
  replaceInlineImageDataUris,
  replaceMarkdownImageDataUris,
} from './nativeImagePasteTransform';

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA';

describe('nativeImagePasteTransform', () => {
  it('replaces markdown image data uris inside larger markdown/html fragments', () => {
    const input = `<table>\n<tr><td>说明</td><td>![](${PNG_DATA_URI})</td></tr>\n</table>`;
    const output = replaceInlineImageDataUris(input, () => './demo.assets/demo-1.png');
    expect(output.matched).toBe(true);
    expect(output.replacement).toContain('![](./demo.assets/demo-1.png)');
    expect(output.replacement).not.toContain('data:image/png;base64');
  });

  it('replaces html img data uris and preserves surrounding html', () => {
    const input = `<td><img src="${PNG_DATA_URI}" alt="x" /></td>`;
    const output = replaceHtmlImageDataUris(input, () => './demo.assets/demo-2.png');
    expect(output.matched).toBe(true);
    expect(output.replacement).toBe('<td><img src="./demo.assets/demo-2.png" alt="x" /></td>');
  });

  it('replaces standalone data uris with markdown image syntax', () => {
    const output = replaceBareImageDataUri(PNG_DATA_URI, () => './demo.assets/demo-3.png');
    expect(output.matched).toBe(true);
    expect(output.replacement).toBe('![](./demo.assets/demo-3.png)');
  });

  it('preserves markdown image title metadata', () => {
    const input = `![示意图](${PNG_DATA_URI} "标题")`;
    const output = replaceMarkdownImageDataUris(input, () => './demo.assets/demo-4.png');
    expect(output.matched).toBe(true);
    expect(output.replacement).toBe('![示意图](./demo.assets/demo-4.png "标题")');
  });
});
