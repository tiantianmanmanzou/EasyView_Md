export interface TextOffsetPatch {
  from: number;
  to: number;
  insert: string;
}

export interface PatchRange {
  from: number;
  to: number;
}

export class TextPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TextPatchError';
  }
}

export function validatePatches(patches: readonly TextOffsetPatch[], contentLength: number): TextOffsetPatch[] {
  const sorted = patches.map((patch) => ({ ...patch })).sort((left, right) => left.from - right.from || left.to - right.to);
  let previousTo = 0;
  for (const patch of sorted) {
    if (!Number.isInteger(patch.from) || !Number.isInteger(patch.to)) {
      throw new TextPatchError('Patch offsets must be integers');
    }
    if (patch.from < 0 || patch.to < patch.from || patch.to > contentLength) {
      throw new TextPatchError(`Patch range [${patch.from}, ${patch.to}) is outside content length ${contentLength}`);
    }
    if (patch.from < previousTo) {
      throw new TextPatchError('Patches must not overlap');
    }
    previousTo = patch.to;
  }
  return sorted;
}

export function applyTextPatches(content: string, patches: readonly TextOffsetPatch[]): string {
  const sorted = validatePatches(patches, content.length);
  let result = content;
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const patch = sorted[index];
    result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to);
  }
  return result;
}

export function minimalTextPatch(from: string, to: string): TextOffsetPatch[] {
  if (from === to) return [];
  let prefix = 0;
  const sharedLength = Math.min(from.length, to.length);
  while (prefix < sharedLength && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;

  let suffix = 0;
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  return [{
    from: prefix,
    to: from.length - suffix,
    insert: to.slice(prefix, to.length - suffix),
  }];
}

export function patchRangesOverlap(left: PatchRange, right: PatchRange): boolean {
  if (left.from === left.to && right.from === right.to) return left.from === right.from;
  return left.from < right.to && right.from < left.to;
}
