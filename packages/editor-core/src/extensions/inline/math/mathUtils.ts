/**
 * Math utility functions.
 */

import type { EditorState } from 'prosemirror-state';

/**
 * Check if the current selection is inside a code block or code mark.
 * Used to prevent math input rules from triggering inside code.
 */
export function isInCode(state: EditorState): boolean {
  const { $from } = state.selection;

  // Check if parent node is a code block
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.spec.code) return true;
  }

  // Check if current position has code_inline mark
  const marks = state.storedMarks || $from.marks();
  return marks.some((mark) => mark.type.name === 'code_inline');
}
