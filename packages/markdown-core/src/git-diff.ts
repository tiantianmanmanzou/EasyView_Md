import { diffChars, diffLines } from 'diff';

export interface GitDiffHunk {
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  kind: 'added' | 'modified' | 'removed';
}
export interface GitDiffRange {
  startLine: number;
  endLine: number;
  kind: 'added' | 'modified';
}

function lines(value: string): string[] {
  if (!value) return [];
  const parts = value.split('\n');
  if (value.endsWith('\n')) parts.pop();
  return parts;
}

function splitContent(value: string): { rows: string[]; endsWithNewline: boolean } {
  const normalized = value.replace(/\r\n/g, '\n');
  return { rows: lines(normalized), endsWithNewline: normalized.endsWith('\n') };
}

function joinContent(rows: string[], endsWithNewline: boolean): string {
  if (rows.length === 0) return endsWithNewline ? '\n' : '';
  return endsWithNewline ? `${rows.join('\n')}\n` : rows.join('\n');
}

/** One Git-index-relative diff for host markers and the embedded source view. */
export function computeGitDiff(baseContent: string, currentContent: string): { hunks: GitDiffHunk[]; lineRanges: GitDiffRange[] } {
  const hunks: GitDiffHunk[] = [];
  const parts = diffLines(baseContent.replace(/\r\n/g, '\n'), currentContent.replace(/\r\n/g, '\n'));
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      const count = lines(part.value).length;
      oldLine += count; newLine += count; i++; continue;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      const change = parts[i++];
      const changed = lines(change.value);
      if (change.removed) { oldLines.push(...changed); oldLine += changed.length; }
      if (change.added) { newLines.push(...changed); newLine += changed.length; }
    }
    hunks.push({ oldStart, oldLines, newStart, newLines, kind: oldLines.length && newLines.length ? 'modified' : newLines.length ? 'added' : 'removed' });
  }
  const maxLine = Math.max(1, currentContent.split('\n').length);
  const lineRanges = hunks.map((hunk): GitDiffRange => ({
    startLine: Math.min(maxLine, hunk.newStart),
    endLine: Math.min(maxLine, hunk.newStart + Math.max(1, hunk.newLines.length) - 1),
    kind: hunk.kind === 'added' ? 'added' : 'modified',
  }));
  return { hunks, lineRanges };
}

/** Apply one hunk onto index/base content to produce the next staged blob. */
export function applyHunkToContent(baseContent: string, hunk: GitDiffHunk): string {
  const { rows, endsWithNewline } = splitContent(baseContent);
  const start = Math.max(0, Math.min(rows.length, hunk.oldStart - 1));
  rows.splice(start, hunk.oldLines.length, ...hunk.newLines);
  return joinContent(rows, endsWithNewline);
}

/** Revert one hunk inside the working-tree content back to the index version. */
export function revertHunkInContent(currentContent: string, hunk: GitDiffHunk): string {
  const { rows, endsWithNewline } = splitContent(currentContent);
  const start = Math.max(0, Math.min(rows.length, hunk.newStart - 1));
  rows.splice(start, hunk.newLines.length, ...hunk.oldLines);
  return joinContent(rows, endsWithNewline);
}

export interface InlineRange {
  from: number;
  to: number;
}

export interface HunkInlineHighlights {
  old: InlineRange[][];
  new: InlineRange[][];
}

const LINE_PAIR_SIMILARITY = 0.35;
const FULL_LINE_COVERAGE = 0.8;

function charSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  let equal = 0;
  for (const part of diffChars(a, b)) {
    if (!part.added && !part.removed) equal += part.value.length;
  }
  return equal / max;
}

function pairModifiedLines(oldLines: readonly string[], newLines: readonly string[]): Array<{ oldIndex: number; newIndex: number }> {
  const candidates: Array<{ oldIndex: number; newIndex: number; score: number }> = [];
  for (let oldIndex = 0; oldIndex < oldLines.length; oldIndex++) {
    for (let newIndex = 0; newIndex < newLines.length; newIndex++) {
      const score = charSimilarity(oldLines[oldIndex], newLines[newIndex]);
      if (score >= LINE_PAIR_SIMILARITY) candidates.push({ oldIndex, newIndex, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.oldIndex - right.oldIndex || left.newIndex - right.newIndex);
  const usedOld = new Set<number>();
  const usedNew = new Set<number>();
  const matched: Array<{ oldIndex: number; newIndex: number }> = [];
  for (const candidate of candidates) {
    if (usedOld.has(candidate.oldIndex) || usedNew.has(candidate.newIndex)) continue;
    usedOld.add(candidate.oldIndex);
    usedNew.add(candidate.newIndex);
    matched.push(candidate);
  }
  return matched;
}

function coverage(ranges: readonly InlineRange[], length: number): number {
  if (length <= 0) return 1;
  return ranges.reduce((sum, range) => sum + Math.max(0, range.to - range.from), 0) / length;
}

function inlineRangesForPair(oldText: string, newText: string): { old: InlineRange[]; new: InlineRange[] } {
  const old: InlineRange[] = [];
  const next: InlineRange[] = [];
  let oldPos = 0;
  let newPos = 0;
  for (const part of diffChars(oldText, newText)) {
    const length = part.value.length;
    if (part.added) {
      next.push({ from: newPos, to: newPos + length });
      newPos += length;
      continue;
    }
    if (part.removed) {
      old.push({ from: oldPos, to: oldPos + length });
      oldPos += length;
      continue;
    }
    oldPos += length;
    newPos += length;
  }
  return {
    old: coverage(old, oldText.length) > FULL_LINE_COVERAGE ? [] : old.filter((range) => range.to > range.from),
    new: coverage(next, newText.length) > FULL_LINE_COVERAGE ? [] : next.filter((range) => range.to > range.from),
  };
}

/** Character-level inserts/deletes inside a modified hunk. Empty when there is no old text to compare. */
export function computeHunkInlineHighlights(oldLines: readonly string[], newLines: readonly string[]): HunkInlineHighlights {
  const old = oldLines.map((): InlineRange[] => []);
  const next = newLines.map((): InlineRange[] => []);
  if (oldLines.length === 0 || newLines.length === 0) return { old, new: next };
  for (const { oldIndex, newIndex } of pairModifiedLines(oldLines, newLines)) {
    const ranges = inlineRangesForPair(oldLines[oldIndex], newLines[newIndex]);
    old[oldIndex] = ranges.old;
    next[newIndex] = ranges.new;
  }
  return { old, new: next };
}

export function findMatchingHunk(
  hunks: readonly GitDiffHunk[],
  identity: Pick<GitDiffHunk, 'oldStart' | 'newStart' | 'kind'>,
): GitDiffHunk | undefined {
  return hunks.find((hunk) => (
    hunk.oldStart === identity.oldStart
    && hunk.newStart === identity.newStart
    && hunk.kind === identity.kind
  ));
}
