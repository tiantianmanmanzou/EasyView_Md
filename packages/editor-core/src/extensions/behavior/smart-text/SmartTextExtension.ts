/**
 * SmartTextExtension
 *
 * Provides:
 * - Typography input rules: -> to arrow, -- to en-dash, ... to ellipsis
 * - Core keymaps: Shift-Enter (hard break), Backspace (block reset),
 *   Mod-Alt-ArrowUp/Down (move block)
 * - Fallback Enter keymap: newlineInCode then splitBlock
 * - Custom base keymap without Enter (to avoid conflicts with list keymaps)
 *
 * NOTE: Mark input rules (bold, italic, etc.) are handled by MarksExtension.
 */

import { InputRule } from 'prosemirror-inputrules';
import type { Schema } from 'prosemirror-model';
import type { Plugin, Transaction } from 'prosemirror-state';
import { EditorState } from 'prosemirror-state';
import {
  baseKeymap,
  chainCommands,
  newlineInCode,
  splitBlock,
} from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { Extension } from '../../../editor/EditorExtension';

// ─── Move Block Commands ─────────────────────────────────────────────────────

function moveBlockUp(
  state: EditorState,
  dispatch?: (tr: Transaction) => void
): boolean {
  const { $from } = state.selection;
  const blockStart = $from.start($from.depth);

  if (blockStart <= 1) return false;
  const before = state.doc.resolve(blockStart - 1);
  if (before.depth < 1) return false;

  if (dispatch) {
    const blockEnd = $from.end($from.depth) + 1;
    const targetPos = before.start(before.depth);
    const tr = state.tr;
    const slice = state.doc.slice(blockStart - 1, blockEnd);
    tr.delete(blockStart - 1, blockEnd);
    tr.insert(
      targetPos > tr.doc.content.size
        ? tr.doc.content.size
        : Math.max(0, targetPos - 1),
      slice.content
    );
    tr.scrollIntoView();
    dispatch(tr);
  }
  return true;
}

function moveBlockDown(
  state: EditorState,
  dispatch?: (tr: Transaction) => void
): boolean {
  const { $from } = state.selection;
  const blockEnd = $from.end($from.depth) + 1;

  if (blockEnd >= state.doc.content.size) return false;

  if (dispatch) {
    const blockStart = $from.start($from.depth) - 1;
    const after = state.doc.resolve(blockEnd);
    const nextEnd = after.end(after.depth) + 1;
    const tr = state.tr;
    const slice = state.doc.slice(blockEnd, nextEnd);
    tr.delete(blockEnd, nextEnd);
    tr.insert(Math.max(0, blockStart), slice.content);
    tr.scrollIntoView();
    dispatch(tr);
  }
  return true;
}

// ─── Smart Text Extension ────────────────────────────────────────────────────

export class SmartTextExtension extends Extension {
  get name() {
    return 'smartText';
  }

  inputRules(_schema: Schema): InputRule[] {
    return [
      // Typography replacements
      new InputRule(/->$/, '\u2192'),    // Arrow: -> → →
      new InputRule(/--$/, '\u2013'),    // En-dash: -- → –
      new InputRule(/\.\.\.$/, '\u2026'), // Ellipsis: ... → …
    ];
  }

  plugins(schema: Schema): Plugin[] {
    // Create baseKeymap without Enter (we handle it ourselves via separate keymap)
    const customBaseKeymap = { ...baseKeymap };
    delete customBaseKeymap['Enter'];

    return [
      // Core keymaps: hard break, block reset, move block
      keymap({
        // Hard break
        'Shift-Enter': (state: EditorState, dispatch?: (tr: Transaction) => void) => {
          if (dispatch) {
            dispatch(
              state.tr
                .replaceSelectionWith(schema.nodes.hard_break.create())
                .scrollIntoView()
            );
          }
          return true;
        },

        // Block reset: Backspace at start of non-paragraph block → paragraph
        Backspace: (state: EditorState, dispatch?: (tr: Transaction) => void) => {
          const { $cursor } = state.selection as any;
          if (!$cursor) return false;
          if ($cursor.parent.type === schema.nodes.paragraph) return false;
          if (
            $cursor.parent.type === schema.nodes.list_item ||
            $cursor.parent.type === schema.nodes.checkbox_item
          ) {
            return false;
          }
          const isEmpty = $cursor.parent.content.size === 0;
          const atStart = $cursor.parentOffset === 0;
          if (isEmpty || atStart) {
            if (dispatch) {
              dispatch(
                state.tr.setBlockType(
                  $cursor.before(),
                  $cursor.after(),
                  schema.nodes.paragraph
                )
              );
            }
            return true;
          }
          return false;
        },

        // Move block up/down
        'Mod-Alt-ArrowUp': moveBlockUp,
        'Mod-Alt-ArrowDown': moveBlockDown,
      }),
      // Fallback Enter handler: newlineInCode first (for code blocks),
      // then splitBlock for everything else
      keymap({
        Enter: chainCommands(newlineInCode, splitBlock),
      }),
      // Base keymap without Enter to avoid conflicts with list keymaps
      keymap(customBaseKeymap),
    ];
  }
}
