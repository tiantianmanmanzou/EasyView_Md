import { describe, expect, it } from 'vitest';
import { Schema } from 'prosemirror-model';
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
      { startLine: 2, endLine: 2, kind: 'modified' },
      { startLine: 3, endLine: 3, kind: 'added' },
    ];

    expect(computeGitBlockChanges(ranges, doc).map((change) => [change.pos, change.kind])).toEqual([
      [7, 'modified'],
      [15, 'added'],
    ]);
  });

  it('rejects stale revisions but accepts the current revision for changed ranges', () => {
    expect(shouldAcceptGitRevision(8, 7)).toBe(false);
    expect(shouldAcceptGitRevision(8, 8)).toBe(true);
    expect(shouldAcceptGitRevision(8, 9)).toBe(true);
  });
});
