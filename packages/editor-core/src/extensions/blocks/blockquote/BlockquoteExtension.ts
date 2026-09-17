/**
 * BlockquoteExtension
 *
 * Handles blockquote nodes: wrapping, input rules, keymaps, and serializer.
 */

import { wrappingInputRule, type InputRule } from 'prosemirror-inputrules';
import type { NodeSpec, Schema } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import { wrapInBlockSmart, liftFromNodeType } from '../../../editor/EditorCommands';

// ─── Blockquote Extension ────────────────────────────────────────────────────

export class BlockquoteExtension extends Extension {
  get name() {
    return 'blockquote';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      blockquote: {
        content: 'block+',
        group: 'block',
        defining: true,
        parseDOM: [{ tag: 'blockquote' }],
        toDOM() {
          return ['blockquote', 0];
        },
      },
    };
  }

  inputRules(schema: Schema): InputRule[] {
    return [
      wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote),
    ];
  }

  keymaps(schema: Schema): Record<string, Command> {
    const toggleBlockquote: Command = (state, dispatch) => {
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type === schema.nodes.blockquote) {
          return liftFromNodeType(schema.nodes.blockquote)(state, dispatch);
        }
      }
      return wrapInBlockSmart(schema.nodes.blockquote)(state, dispatch);
    };
    return { 'Ctrl-Shift-b': toggleBlockquote };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      blockquote(state, node) {
        state.wrapBlock('> ', null, node, () => state.renderContent(node));
      },
    };
  }
}
