/**
 * Block Edge Cursor — Utility functions
 *
 * Determines where block edge cursors can appear.
 * Key difference from prosemirror-gapcursor: we require only ONE side
 * to be a "gap-requiring" node (atom or isolating), not BOTH sides.
 */

import type { ResolvedPos, Node as ProsemirrorNode, NodeType } from 'prosemirror-model';
import { NodeSelection } from 'prosemirror-state';

/**
 * Check if a node type requires a gap cursor at its edges.
 * Matches prosemirror-gapcursor's needsGap() but as a public function.
 */
function needsGap(type: NodeType): boolean {
  return type.isAtom || !!type.spec.isolating;
}

/**
 * Check if the content before $pos is "closed" — i.e. a gap cursor
 * should appear because there's no inline editing position there.
 *
 * Walks from the position upward through ancestors, checking the node
 * just before the position at each depth. Dives into the last child
 * recursively to find the deepest relevant node.
 */
export function closedBefore($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d >= 0; d--) {
    const index = $pos.index(d);
    const parent = $pos.node(d);
    if (index === 0) {
      if (parent.type.spec.isolating) return true;
      continue;
    }
    for (let before = parent.child(index - 1); ; before = before.lastChild!) {
      if ((before.childCount === 0 && !before.inlineContent) || needsGap(before.type))
        return true;
      if (before.inlineContent)
        return false;
    }
  }
  return true;
}

/**
 * Check if the content after $pos is "closed" — symmetric to closedBefore.
 */
export function closedAfter($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d >= 0; d--) {
    const index = $pos.indexAfter(d);
    const parent = $pos.node(d);
    if (index === parent.childCount) {
      if (parent.type.spec.isolating) return true;
      continue;
    }
    for (let after = parent.child(index); ; after = after.firstChild!) {
      if ((after.childCount === 0 && !after.inlineContent) || needsGap(after.type))
        return true;
      if (after.inlineContent)
        return false;
    }
  }
  return true;
}

/**
 * Check if a block edge cursor is valid at this position.
 *
 * KEY DIFFERENCE from prosemirror-gapcursor:
 * Standard requires BOTH sides to be closed. We require only ONE side,
 * BUT at least one immediate neighbor must actually be a gap-requiring
 * node (atom or isolating). This prevents false positives at document
 * boundaries next to regular textblocks.
 */
export function isValidBlockEdge($pos: ResolvedPos): boolean {
  const parent = $pos.parent;
  if (parent.isTextblock) return false;

  const override = parent.type.spec.allowGapCursor;
  if (override != null) return override;

  // At least one side must be structurally closed
  if (!closedBefore($pos) && !closedAfter($pos)) return false;

  // At least one immediate neighbor must be a gap-requiring node
  const nodeBefore = $pos.nodeBefore;
  const nodeAfter = $pos.nodeAfter;
  if ((!nodeBefore || !needsGap(nodeBefore.type)) &&
      (!nodeAfter || !needsGap(nodeAfter.type))) {
    return false;
  }

  // A textblock (paragraph) must be insertable at this position
  const deflt = parent.contentMatchAt($pos.index()).defaultType;
  return deflt != null && deflt.isTextblock;
}

/**
 * Find a valid block edge cursor position starting from $pos,
 * scanning in the given direction (1 = forward, -1 = backward).
 *
 * Algorithm adapted from GapCursor.findGapCursorFrom.
 */
export function findBlockEdgeFrom(
  $pos: ResolvedPos,
  dir: number,
  mustMove = false
): ResolvedPos | null {
  search: for (;;) {
    if (!mustMove && isValidBlockEdge($pos)) return $pos;

    let pos = $pos.pos;
    let next: ProsemirrorNode | null = null;

    // Scan up from this position
    for (let d = $pos.depth; ; d--) {
      const parent = $pos.node(d);
      if (dir > 0 ? $pos.indexAfter(d) < parent.childCount : $pos.index(d) > 0) {
        next = parent.child(dir > 0 ? $pos.indexAfter(d) : $pos.index(d) - 1);
        break;
      } else if (d === 0) {
        return null;
      }
      pos += dir;
      const $cur = $pos.doc.resolve(pos);
      if (isValidBlockEdge($cur)) return $cur;
    }

    // Then scan down into the next node
    for (;;) {
      const inside = dir > 0 ? next!.firstChild : next!.lastChild;
      if (!inside) {
        if (next!.isAtom && !next!.isText && !NodeSelection.isSelectable(next!)) {
          $pos = $pos.doc.resolve(pos + next!.nodeSize * dir);
          mustMove = false;
          continue search;
        }
        break;
      }
      next = inside;
      pos += dir;
      const $cur = $pos.doc.resolve(pos);
      if (isValidBlockEdge($cur)) return $cur;
    }

    return null;
  }
}
