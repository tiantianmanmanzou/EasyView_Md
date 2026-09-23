import { buildMarkdownDocumentIndex, type MarkdownBlockRange, type MarkdownDocumentIndex } from './blockIndex';

export interface TextOffsetPatch {
  from: number;
  to: number;
  insert: string;
}

export interface PatchImpact {
  originalRange: { start: number; end: number };
  expandedRange: { start: number; end: number };
  reasons: readonly string[];
  affectedBlocks: readonly MarkdownBlockRange[];
  requiresDocumentRebuild: boolean;
}

export interface AppliedPatchImpact {
  content: string;
  index: MarkdownDocumentIndex;
  impact: PatchImpact;
  affectedBlockRanges: readonly MarkdownBlockRange[];
}

function validatePatches(contentLength: number, patches: readonly TextOffsetPatch[]): TextOffsetPatch[] {
  const sorted = [...patches].sort((a, b) => a.from - b.from || a.to - b.to);
  let previousEnd = 0;
  for (const patch of sorted) {
    if (!Number.isInteger(patch.from) || !Number.isInteger(patch.to) || patch.from < 0 || patch.to < patch.from || patch.to > contentLength) {
      throw new RangeError(`Invalid patch range: [${patch.from}, ${patch.to})`);
    }
    if (patch.from < previousEnd) throw new RangeError('Overlapping patches are not supported');
    previousEnd = patch.to;
  }
  return sorted;
}

export function applyTextOffsetPatches(content: string, patches: readonly TextOffsetPatch[]): string {
  const sorted = validatePatches(content.length, patches);
  let result = content;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const patch = sorted[index];
    result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
  }
  return result;
}

function patchRange(content: string, patches: readonly TextOffsetPatch[]): { start: number; end: number } {
  if (patches.length === 0) return { start: 0, end: 0 };
  const sorted = validatePatches(content.length, patches);
  return { start: sorted[0].from, end: sorted[sorted.length - 1].to };
}

function intersects(block: MarkdownBlockRange, start: number, end: number): boolean {
  if (start === end) return block.start <= start && start <= block.end;
  return block.start < end && start < block.end;
}

function shiftedOffset(offset: number, patches: readonly TextOffsetPatch[]): number {
  let delta = 0;
  for (const patch of patches) {
    if (patch.to <= offset) delta += patch.insert.length - (patch.to - patch.from);
    else break;
  }
  return offset + delta;
}

function shiftedRange(block: MarkdownBlockRange, patches: readonly TextOffsetPatch[]): MarkdownBlockRange {
  return { ...block, start: shiftedOffset(block.start, patches), end: shiftedOffset(block.end, patches) };
}

/**
 * Conservative invalidation analysis for the PoC. Local constructs invalidate
 * their containing top-level block; constructs with global Markdown dependencies
 * invalidate the complete document so callers cannot apply an unsafe partial parse.
 */
export function analyzePatchImpact(index: MarkdownDocumentIndex, patches: readonly TextOffsetPatch[]): PatchImpact {
  const range = patchRange(index.content, patches);
  const directlyAffected = index.blocks.filter((block) => intersects(block, range.start, range.end));
  const reasons = new Set<string>();
  let requiresDocumentRebuild = false;

  for (const block of directlyAffected) {
    if (block.invalidationScope === 'document') {
      requiresDocumentRebuild = true;
      reasons.add(block.type);
    }
  }

  // A patch at a blank-line boundary can create/remove a block, so include both
  // neighboring blocks and avoid claiming that only one old range is sufficient.
  const neighboring = index.blocks.filter((block) => intersects(block, range.start - 1, range.end + 1));
  const affected = new Map<number, MarkdownBlockRange>(neighboring.map((block) => [block.id, block]));
  for (const block of directlyAffected) affected.set(block.id, block);

  if (directlyAffected.some((block) => block.type === 'chartFence')) reasons.add('chartFenceBoundary');
  if (directlyAffected.some((block) => block.type === 'tableMetadata')) {
    requiresDocumentRebuild = true;
    reasons.add('tableMetadata');
  }
  if (directlyAffected.some((block) => block.type === 'referenceDefinition' || block.type === 'footnote')) {
    requiresDocumentRebuild = true;
    reasons.add('documentReferenceDependency');
  }
  if (directlyAffected.some((block) => block.type === 'frontmatter')) {
    requiresDocumentRebuild = true;
    reasons.add('frontmatter');
  }

  const expandedRange = requiresDocumentRebuild
    ? { start: 0, end: index.content.length }
    : {
        start: Math.min(...[...affected.values()].map((block) => block.start), range.start),
        end: Math.max(...[...affected.values()].map((block) => block.end), range.end),
      };
  const selected = requiresDocumentRebuild ? [...index.blocks] : [...affected.values()].sort((a, b) => a.start - b.start);
  return { originalRange: range, expandedRange, reasons: [...reasons], affectedBlocks: selected, requiresDocumentRebuild };
}

/** Applies patches, returns the conservative old ranges, and always rebuilds the index for comparison. */
export function applyPatchesAndGetAffectedBlockRanges(index: MarkdownDocumentIndex, patches: readonly TextOffsetPatch[]): AppliedPatchImpact {
  const impact = analyzePatchImpact(index, patches);
  const content = applyTextOffsetPatches(index.content, patches);
  const rebuilt = buildMarkdownDocumentIndex(content);
  const newStart = shiftedOffset(impact.expandedRange.start, patches);
  const newEnd = shiftedOffset(impact.expandedRange.end, patches);
  const affectedBlockRanges = impact.requiresDocumentRebuild
    ? rebuilt.blocks
    : rebuilt.blocks.filter((block) => intersects(block, newStart, newEnd));
  return { content, index: rebuilt, impact, affectedBlockRanges };
}
