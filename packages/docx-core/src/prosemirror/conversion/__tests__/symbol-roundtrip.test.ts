import { describe, expect, test } from 'bun:test';
import type { Document, Paragraph, Run } from '../../../types/document';
import { fromProseDoc } from '../fromProseDoc';
import { toProseDoc } from '../toProseDoc';

const symbolRun = (char: string): Run => ({
  type: 'run',
  formatting: { fontFamily: { ascii: '仿宋_GB2312' } },
  content: [{ type: 'symbol', font: 'Wingdings 2', char }],
});

describe('w:sym checkboxes', () => {
  test('show as Unicode boxes and save back as the original symbols', () => {
    const paragraph: Paragraph = {
      type: 'paragraph',
      content: [
        symbolRun('0052'),
        { type: 'run', content: [{ type: 'text', text: ' 1.' }] },
        symbolRun('F0A3'),
        symbolRun('F0A3'),
      ],
    };
    const input: Document = { package: { document: { content: [paragraph] } } };

    const pmDoc = toProseDoc(input);
    expect(pmDoc.firstChild!.textContent).toBe('☑ 1.☐☐');

    const out = fromProseDoc(pmDoc, input).package.document.content[0] as Paragraph;
    const items = out.content
      .filter((content): content is Run => content.type === 'run')
      .flatMap((run) => run.content.map((item) => (item.type === 'symbol' ? `${item.font}:${item.char}` : item.type === 'text' ? item.text : '')));
    expect(items).toEqual(['Wingdings 2:0052', ' 1.', 'Wingdings 2:F0A3', 'Wingdings 2:F0A3']);
  });
});
