import { describe, expect, it } from 'vitest';
import {
  applyPatchesAndGetAffectedBlockRanges,
  buildLineStartIndex,
  buildMarkdownDocumentIndex,
} from '../index';

const fixture = [
  '---',
  'title: Demo',
  '---',
  '',
  '# Heading',
  '',
  'A paragraph with 😀.',
  '',
  '> quoted text',
  '> continued',
  '',
  '- one',
  '- two',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'graph TD',
  '```',
  '',
  '<table>',
  '<tr><td>x</td></tr>',
  '</table>',
  '',
  '[ref]: https://example.com',
  '[^note]: footnote',
].join('\n');

describe('markdown document index PoC', () => {
  it('builds UTF-16 line starts and line ranges', () => {
    const content = 'a\n😀b\nlast';
    const index = buildLineStartIndex(content);
    expect(index.starts).toEqual([0, 2, 6]);
    expect(index.lineAt(3)).toBe(1);
    expect(index.range(1)).toEqual({ line: 1, start: 2, contentEnd: 5, end: 6 });
    expect(index.sliceLines(1, 3)).toBe('😀b\nlast');
    const crlf = buildLineStartIndex('a\r\nb');
    expect(crlf.range(0)).toEqual({ line: 0, start: 0, contentEnd: 1, end: 3 });
  });

  it('indexes the first block families and document-scope dependencies', () => {
    const index = buildMarkdownDocumentIndex(fixture);
    expect(index.blocks.map((block) => block.type)).toEqual([
      'frontmatter',
      'heading',
      'paragraph',
      'blockquote',
      'list',
      'table',
      'chartFence',
      'htmlTable',
      'referenceDefinition',
      'footnote',
    ]);
    expect(index.blocks.filter((block) => block.invalidationScope === 'document').map((block) => block.type)).toEqual([
      'frontmatter',
      'referenceDefinition',
      'footnote',
    ]);
  });

  it('returns the affected paragraph range and agrees with a full rebuild after a patch', () => {
    const index = buildMarkdownDocumentIndex(fixture);
    const paragraph = index.blocks.find((block) => block.type === 'paragraph')!;
    const patch = { from: paragraph.start + 2, to: paragraph.start + 3, insert: 'X' };
    const result = applyPatchesAndGetAffectedBlockRanges(index, [patch]);
    const expected = buildMarkdownDocumentIndex(result.content);
    expect(result.impact.requiresDocumentRebuild).toBe(false);
    expect(result.affectedBlockRanges.map((block) => block.type)).toEqual(['paragraph']);
    expect(result.index.blocks.map((block) => [block.type, block.text])).toEqual(
      expected.blocks.map((block) => [block.type, block.text]),
    );
  });

  it('expands a patch touching a chart fence to the fence block', () => {
    const index = buildMarkdownDocumentIndex(fixture);
    const chart = index.blocks.find((block) => block.type === 'chartFence')!;
    const result = applyPatchesAndGetAffectedBlockRanges(index, [{ from: chart.start, to: chart.start + 3, insert: '```' }]);
    expect(result.impact.reasons).toContain('chartFenceBoundary');
    expect(result.affectedBlockRanges.map((block) => block.type)).toEqual(['chartFence']);
  });

  it('expands table metadata invalidation to the adjacent Markdown table', () => {
    const content = '<!-- table-style: compact -->\n| A | B |\n|---|---|\n| 1 | 2 |';
    const index = buildMarkdownDocumentIndex(content);
    const metadata = index.blocks.find((block) => block.type === 'tableMetadata')!;
    const result = applyPatchesAndGetAffectedBlockRanges(index, [{ from: metadata.start, to: metadata.end, insert: '<!-- table-style: wide -->' }]);
    expect(result.impact.reasons).toContain('tableMetadata');
    expect(result.impact.requiresDocumentRebuild).toBe(true);
    expect(result.affectedBlockRanges.map((block) => block.type)).toEqual(['tableMetadata', 'table']);
  });

  it('forces a document rebuild for references and footnotes', () => {
    const index = buildMarkdownDocumentIndex(fixture);
    const reference = index.blocks.find((block) => block.type === 'referenceDefinition')!;
    const result = applyPatchesAndGetAffectedBlockRanges(index, [{ from: reference.start, to: reference.end, insert: '[ref]: https://new.example' }]);
    expect(result.impact.requiresDocumentRebuild).toBe(true);
    expect(result.impact.expandedRange).toEqual({ start: 0, end: fixture.length });
    expect(result.affectedBlockRanges.length).toBe(result.index.blocks.length);
  });

  it('rejects overlapping and out-of-range patches', () => {
    const index = buildMarkdownDocumentIndex('hello');
    expect(() => applyPatchesAndGetAffectedBlockRanges(index, [
      { from: 0, to: 3, insert: 'x' },
      { from: 2, to: 4, insert: 'y' },
    ])).toThrow('Overlapping');
    expect(() => applyPatchesAndGetAffectedBlockRanges(index, [{ from: 0, to: 99, insert: 'x' }])).toThrow('Invalid patch range');
  });
});
