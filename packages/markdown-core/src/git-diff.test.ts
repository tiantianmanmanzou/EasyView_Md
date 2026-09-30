import { describe, expect, it } from 'vitest';
import { applyHunkToContent, computeGitDiff, computeHunkInlineHighlights, revertHunkInContent } from './git-diff';

describe('computeGitDiff', () => {
  it('marks additions, modifications and removals against the index content', () => {
    const result = computeGitDiff('one\ntwo\nthree\n', 'one\nchanged\nthree\nfour\n');
    expect(result.hunks).toEqual([
      { oldStart: 2, oldLines: ['two'], newStart: 2, newLines: ['changed'], kind: 'modified' },
      { oldStart: 4, oldLines: [], newStart: 4, newLines: ['four'], kind: 'added' },
    ]);
    expect(result.lineRanges).toEqual([
      { startLine: 2, endLine: 2, kind: 'modified' },
      { startLine: 4, endLine: 4, kind: 'added' },
    ]);
  });

  it('treats an untracked file as additions from an empty base', () => {
    expect(computeGitDiff('', '# title\nbody').lineRanges).toEqual([{ startLine: 1, endLine: 2, kind: 'added' }]);
  });
});

describe('hunk stage/revert helpers', () => {
  it('stages one modified hunk into the index content', () => {
    const base = 'one\ntwo\nthree\n';
    const current = 'one\nchanged\nthree\nfour\n';
    const [modified] = computeGitDiff(base, current).hunks;
    expect(applyHunkToContent(base, modified)).toBe('one\nchanged\nthree\n');
  });

  it('reverts one added hunk in the working tree', () => {
    const base = 'one\ntwo\nthree\n';
    const current = 'one\nchanged\nthree\nfour\n';
    const added = computeGitDiff(base, current).hunks[1];
    expect(revertHunkInContent(current, added)).toBe('one\nchanged\nthree\n');
  });

  it('reverts a removed hunk by restoring the deleted lines', () => {
    const base = 'one\ntwo\nthree\n';
    const current = 'one\nthree\n';
    const [removed] = computeGitDiff(base, current).hunks;
    expect(removed.kind).toBe('removed');
    expect(revertHunkInContent(current, removed)).toBe('one\ntwo\nthree\n');
  });
});

describe('computeHunkInlineHighlights', () => {
  it('marks the replaced fragment when a shared prefix remains', () => {
    const result = computeHunkInlineHighlights(['hello two'], ['hello changed']);
    expect(result.new[0]).toEqual([{ from: 6, to: 13 }]);
    expect(result.old[0]).toEqual([{ from: 6, to: 9 }]);
    const added = 'hello changed'.slice(result.new[0][0].from, result.new[0][0].to);
    const removed = 'hello two'.slice(result.old[0][0].from, result.old[0][0].to);
    expect(added).toBe('changed');
    expect(removed).toBe('two');
  });

  it('skips fragment marks when almost the whole line changed', () => {
    const result = computeHunkInlineHighlights(['two'], ['changed']);
    expect(result.old[0]).toEqual([]);
    expect(result.new[0]).toEqual([]);
  });

  it('highlights only the replaced Chinese fragment in a table row', () => {
    const oldLine = '| 页面加载 | 有页面查看权限 | 按时间周期三组分类统 |';
    const newLine = '| 页面加载 | 有页面查看权限 | 与按业务部门 TOP10 分类统计 |';
    const result = computeHunkInlineHighlights([oldLine], [newLine]);
    expect(result.new[0].length).toBeGreaterThan(0);
    const marked = result.new[0].map((range) => newLine.slice(range.from, range.to)).join('');
    expect(marked).toContain('TOP10');
    expect(marked).not.toContain('页面加载');
    expect(oldLine.slice(0, 18)).toBe(newLine.slice(0, 18));
    expect(result.new[0][0].from).toBeGreaterThan(10);
  });

  it('returns empty marks for added-only hunks', () => {
    expect(computeHunkInlineHighlights([], ['four'])).toEqual({ old: [], new: [[]] });
  });
});
