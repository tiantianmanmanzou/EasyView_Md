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
        // If this transaction is marked as grip selection
        if (tr.getMeta('gripSelection')) {
          return { isGripSelection: true };
        }

        // If explicitly clearing grip selection
        if (tr.getMeta('gripSelection') === false) {
          return { isGripSelection: false };
        }

        // Clear grip selection only on user pointer/click actions
        if (tr.getMeta('pointer')) {
          return { isGripSelection: false };
        }

        // Keep grip selection flag otherwise (even if selection changes programmatically)
        return state;
      }
    }
  });
}
