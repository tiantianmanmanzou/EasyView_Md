/**
 * Grip Selection Plugin
 *
 * Tracks whether the current selection was made via table grip clicks
 */

import { Plugin, PluginKey } from 'prosemirror-state';

export interface GripSelectionState {
  isGripSelection: boolean;
}

export const gripSelectionKey = new PluginKey<GripSelectionState>('gripSelection');

export function gripSelectionPlugin() {
  return new Plugin<GripSelectionState>({
    key: gripSelectionKey,
    state: {
      init: () => ({ isGripSelection: false }),
      apply: (tr, state) => {
        // Grip-initiated selections set this meta together with the new selection.
        if (tr.getMeta('gripSelection') === true) {
          return { isGripSelection: true };
        }

        // Explicit clear, or any later selection change (pointer, keyboard, etc.).
        // Previously only `pointer` meta cleared the flag, so after a grip click
        // keyboard / delayed selection updates kept hiding the floating toolbar.
        if (tr.getMeta('gripSelection') === false || tr.selectionSet) {
          return { isGripSelection: false };
        }

        return state;
      }
    }
  });
}
