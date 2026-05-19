/**
 * TrailingNodeExtension
 *
 * Ensures the document always ends with a paragraph.
 * Appends an empty paragraph if the last node is something else.
 */

import { Plugin, PluginKey, type Transaction, type EditorState } from 'prosemirror-state';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';

export class TrailingNodeExtension extends Extension {
  get name() {
    return 'trailingNode';
  }

  plugins(schema: Schema): Plugin[] {
    return [
      new Plugin({
        key: new PluginKey('trailingNode'),
        appendTransaction(
          _transactions: readonly Transaction[],
          _oldState: EditorState,
          newState: EditorState
        ) {
          const lastNode = newState.doc.lastChild;
          if (!lastNode || lastNode.type.name !== 'paragraph') {
            const { tr } = newState;
            tr.insert(newState.doc.content.size, schema.nodes.paragraph.create());
            return tr;
          }
          return null;
        },
      }),
    ];
  }
}
