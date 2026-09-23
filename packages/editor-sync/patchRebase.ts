import { patchRangesOverlap, type TextOffsetPatch } from './textOffsetPatch';

export interface RebaseResult {
  patches: TextOffsetPatch[];
  conflict: boolean;
}

function mapOffset(offset: number, change: TextOffsetPatch): number {
  const delta = change.insert.length - (change.to - change.from);
  if (offset <= change.from) return offset;
  if (offset >= change.to) return offset + delta;
  return change.from + change.insert.length;
}

export function rebasePatches(
  patches: readonly TextOffsetPatch[],
  over: readonly TextOffsetPatch[],
): RebaseResult {
  const rebased: TextOffsetPatch[] = [];
  for (const patch of patches) {
    let current = { ...patch };
    for (const change of over) {
      if (patchRangesOverlap(current, change) || (current.from === current.to && current.from > change.from && current.from < change.to)) {
        return { patches: [], conflict: true };
      }
      current = {
        from: mapOffset(current.from, change),
        to: mapOffset(current.to, change),
        insert: current.insert,
      };
    }
    rebased.push(current);
  }
  return { patches: rebased, conflict: false };
}
