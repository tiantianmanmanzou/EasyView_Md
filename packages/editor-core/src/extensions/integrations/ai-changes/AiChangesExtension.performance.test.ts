// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Schema } from 'prosemirror-model';
import { createParser, parseMarkdown, extractBlockLineMap } from '../../../editor/lib/MarkdownParser';
import {
  computeGitBlockChanges,
  shouldAcceptGitRevision,
  type GitLineRange,
} from './AiChangesExtension';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
  },
});

function documentOf(...paragraphs: string[]) {
  return schema.node('doc', null, paragraphs.map((text) => schema.node('paragraph', null, text ? [schema.text(text)] : [])));
}

describe('AiChangesExtension derived Git state', () => {
  it('matches sorted line ranges with a single forward scan', () => {
    const doc = documentOf('first', 'second', 'third');
    const ranges: GitLineRange[] = [
      { startLine: 3, endLine: 3, kind: 'modified' },
      { startLine: 5, endLine: 5, kind: 'added' },
    ];

    expect(computeGitBlockChanges(ranges, doc, 'first\n\nsecond\n\nthird').map((change) => [change.pos, change.kind])).toEqual([
      [7, 'modified'],
      [15, 'added'],
    ]);
  });

  it('rejects stale revisions but accepts the current revision for changed ranges', () => {
    expect(shouldAcceptGitRevision(8, 7)).toBe(false);
    expect(shouldAcceptGitRevision(8, 8)).toBe(true);
    expect(shouldAcceptGitRevision(8, 9)).toBe(true);
  });

  it('maps separated changes to their real blocks after blank lines, lists, tables and fences', () => {
    const markdown = '# Heading\n\n- first\n- second\n\n```text\nunchanged\nchanged code\n```\n\n| A | B |\n| --- | --- |\n| changed | value |\n\nFinal changed paragraph';
    const doc = parseMarkdown(markdown, createParser())!;
    const changes = computeGitBlockChanges([8, 13, 15].map((line) => ({ startLine: line, endLine: line, kind: 'modified' })), doc, markdown);
    expect(changes.map((change) => doc.nodeAt(change.pos)?.type.name)).toEqual(['code_block', 'table', 'paragraph']);
    expect(changes.map((change) => change.startLine)).toEqual([8, 13, 15]);
    expect(changes.map((change) => change.overviewRatios)).toEqual([[7 / 14], [12 / 14], [1]]);
  });

  it('preserves multiple overview locations within one code block', () => {
    const markdown = '# Heading\n\n```\nfirst change\nunchanged\nsecond change\n```\n\nEnd';
    const doc = parseMarkdown(markdown, createParser())!;
    const changes = computeGitBlockChanges([4, 6].map((line) => ({ startLine: line, endLine: line, kind: 'modified' })), doc, markdown);
    expect(changes).toHaveLength(1);
    expect(changes[0].overviewRatios).toEqual([3 / 8, 5 / 8]);
  });

  it('keeps frontmatter and HTML table source ranges aligned with parsed blocks', () => {
    const markdown = '---\ntitle: Example\n---\n\n# Heading\n\n<table>\n<tr><td>changed</td></tr>\n</table>\n\nFinal paragraph';
    const doc = parseMarkdown(markdown, createParser())!;
    expect(extractBlockLineMap(markdown)).toEqual([
      { startLine: 1, endLine: 3 }, { startLine: 5, endLine: 5 },
      { startLine: 7, endLine: 9 }, { startLine: 11, endLine: 11 },
    ]);
    const changes = computeGitBlockChanges([2, 8, 11].map((line) => ({ startLine: line, endLine: line, kind: 'modified' })), doc, markdown);
    expect(changes.map((change) => doc.nodeAt(change.pos)?.type.name)).toEqual(['frontmatter', 'table', 'paragraph']);
  });
});
