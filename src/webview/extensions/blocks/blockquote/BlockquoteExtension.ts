/**
 * BlockquoteExtension
 *
 * Handles blockquote nodes: wrapping, input rules, keymaps, and serializer.
 */

import { wrappingInputRule, type InputRule } from 'prosemirror-inputrules';
import type { NodeSpec, Schema } from 'prosemirror-model';
import type { Command } from 'prosemirror-commands';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import { wrapInBlockSmart } from '../../../editor/EditorCommands';

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
    return {
      'Ctrl-Shift-b': wrapInBlockSmart(schema.nodes.blockquote),
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      blockquote(state, node) {
        state.wrapBlock('> ', null, node, () => state.renderContent(node));
      },
    };
  }
}
