/**
 * Link commands for ProseMirror.
 * Based on Outline: shared/editor/commands/link.ts (TextSelection variants only)
 */
import type { Attrs } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import { Selection, TextSelection } from 'prosemirror-state';
import { getMarkRange } from '../../../editor/lib/MarkRange';

/**
 * Add a link mark to the current text selection.
 * Moves cursor to the end of the link after adding.
 */
export const addLink =
  (attrs: Attrs): Command =>
  (state, dispatch) => {
    if (!(state.selection instanceof TextSelection)) {
      return false;
    }

    dispatch?.(
      state.tr
        .setSelection(TextSelection.create(state.doc, state.tr.selection.to))
        .addMark(
          state.selection.from,
          state.selection.to,
          state.schema.marks.link.create(attrs)
        )
    );

    return true;
  };

/**
 * Update the href of an existing link at the current position.
 * Finds the full mark range, removes old mark, adds new one.
 */
export const updateLink =
  (attrs: Attrs): Command =>
  (state, dispatch) => {
    if (!(state.selection instanceof TextSelection)) {
      return false;
    }

    const range = getMarkRange(state.selection.$from, state.schema.marks.link);

    if (range && range.mark) {
      const nextSelection =
        Selection.findFrom(state.doc.resolve(range.to), 1, true) ??
        TextSelection.create(state.tr.doc, 0);
      dispatch?.(
        state.tr
          .setSelection(nextSelection)
          .removeMark(range.from, range.to, state.schema.marks.link)
          .addMark(range.from, range.to, state.schema.marks.link.create(attrs))
      );
      return true;
    }
    return false;
  };

/**
 * Remove the link mark from the current position.
 */
export const removeLink = (): Command => (state, dispatch) => {
  if (!(state.selection instanceof TextSelection)) {
    return false;
  }
  const range = getMarkRange(state.selection.$from, state.schema.marks.link);
  if (range && range.mark) {
    const nextSelection =
      Selection.findFrom(state.doc.resolve(range.to), 1, true) ??
      TextSelection.create(state.tr.doc, 0);
    dispatch?.(
      state.tr
        .setSelection(nextSelection)
        .removeMark(range.from, range.to, range.mark)
    );
    return true;
  }
  return false;
};
