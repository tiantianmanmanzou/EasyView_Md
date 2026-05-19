/**
 * HorizontalRuleExtension
 *
 * Handles horizontal rule (thematic break) nodes.
 */

import { InputRule } from 'prosemirror-inputrules';
import type { NodeSpec, Schema } from 'prosemirror-model';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

export class HorizontalRuleExtension extends Extension {
  get name() {
    return 'horizontalRule';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      horizontal_rule: {
        group: 'block',
        atom: true,
        selectable: true,
        parseDOM: [{ tag: 'hr' }],
        toDOM() {
          return ['hr'];
        },
      },
    };
  }

  inputRules(schema: Schema): InputRule[] {
    return [
      new InputRule(/^(?:---|\*\*\*|___)\s$/, (state, _match, start, end) => {
        return state.tr.replaceWith(
          start - 1,
          end,
          schema.nodes.horizontal_rule.create()
        );
      }),
    ];
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      horizontal_rule(state, node) {
        state.write('---');
        state.closeBlock(node);
      },
    };
  }
}
