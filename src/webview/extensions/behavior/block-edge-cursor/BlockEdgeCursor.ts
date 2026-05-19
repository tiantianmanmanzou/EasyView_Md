/**
 * BlockEdgeCursor — custom Selection subclass
 *
 * Extends Selection directly (NOT GapCursor) to avoid importing
 * prosemirror-gapcursor which registers a duplicate jsonID.
 *
 * Uses relaxed validation: only ONE side needs to be a "gap-requiring"
 * node (atom or isolating), instead of BOTH sides as in standard gapcursor.
 */

import { Selection } from 'prosemirror-state';
import type { ResolvedPos, Node as ProsemirrorNode } from 'prosemirror-model';
import type { Mappable } from 'prosemirror-transform';
import { Slice } from 'prosemirror-model';
import { isValidBlockEdge, findBlockEdgeFrom } from './blockEdgeUtils';

// ─── Bookmark ─────────────────────────────────────────────────────────────────

class BlockEdgeBookmark {
  constructor(readonly pos: number) {}

  map(mapping: Mappable): BlockEdgeBookmark {
    return new BlockEdgeBookmark(mapping.map(this.pos));
  }

  resolve(doc: ProsemirrorNode): Selection {
    const $pos = doc.resolve(this.pos);
    return isValidBlockEdge($pos)
      ? new BlockEdgeCursor($pos)
      : Selection.near($pos);
  }
}

// ─── Selection ────────────────────────────────────────────────────────────────

export class BlockEdgeCursor extends Selection {
  constructor($pos: ResolvedPos) {
    super($pos, $pos);
  }

  map(doc: ProsemirrorNode, mapping: Mappable): Selection {
    const $pos = doc.resolve(mapping.map(this.head));
    return isValidBlockEdge($pos)
      ? new BlockEdgeCursor($pos)
      : Selection.near($pos);
  }

  content(): Slice {
    return Slice.empty;
  }

  eq(other: Selection): boolean {
    return other instanceof BlockEdgeCursor && other.head === this.head;
  }

  toJSON(): any {
    return { type: 'blockEdgeCursor', pos: this.head };
  }

  static fromJSON(doc: ProsemirrorNode, json: any): BlockEdgeCursor {
    if (typeof json.pos !== 'number')
      throw new RangeError('Invalid input for BlockEdgeCursor.fromJSON');
    return new BlockEdgeCursor(doc.resolve(json.pos));
  }

  getBookmark(): BlockEdgeBookmark {
    return new BlockEdgeBookmark(this.anchor);
  }

  /**
   * Validate a position for block edge cursor.
   * Uses our relaxed validation (one side closed, not both).
   */
  static valid($pos: ResolvedPos): boolean {
    return isValidBlockEdge($pos);
  }

  /**
   * Find a valid block edge cursor position from $pos in the given direction.
   */
  static findBlockEdgeCursorFrom(
    $pos: ResolvedPos,
    dir: number,
    mustMove = false
  ): ResolvedPos | null {
    return findBlockEdgeFrom($pos, dir, mustMove);
  }
}

// Not visible in the DOM — rendering is handled by the extension overlay
BlockEdgeCursor.prototype.visible = false;

// Alias for compatibility
(BlockEdgeCursor as any).findFrom = BlockEdgeCursor.findBlockEdgeCursorFrom;

// Register under unique ID for JSON serialization
Selection.jsonID('blockEdgeCursor', BlockEdgeCursor);
