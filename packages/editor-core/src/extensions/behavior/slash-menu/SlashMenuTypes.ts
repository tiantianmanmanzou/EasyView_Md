import type { EditorView } from 'prosemirror-view';

/**
 * A command exposed by the slash menu.
 *
 * This type intentionally lives below both the menu renderer and the default
 * item definitions so neither module needs to depend on the other.
 */
export interface SlashMenuItem {
  id: string;
  label: string;
  icon: string;
  keywords: string[];
  /** Group for visual separators between categories */
  group: string;
  /** Receives the view and the range [parentStart, parentEnd] of the paragraph to replace */
  command: (view: EditorView, parentStart: number, parentEnd: number) => void;
}
