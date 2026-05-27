/**
 * PlaceholderExtension
 *
 * Shows placeholder text on empty paragraphs at cursor position.
 * Also shows a + button to trigger slash menu on empty top-level paragraphs.
 */

import {
  Plugin,
  PluginKey,
  type EditorState,
} from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';

export class PlaceholderExtension extends Extension {
  get name() {
    return 'placeholder';
  }

  plugins(_schema: Schema): Plugin[] {
    return [this.placeholderPlugin(), this.plusButtonPlugin()];
  }

  private placeholderPlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('placeholder'),
      props: {
        decorations(state: EditorState) {
          const doc = state.doc;
          const { $from, empty } = state.selection as any;

          if (!empty) return DecorationSet.empty;

          if ($from.parent.isTextblock && $from.parent.content.size === 0) {
            // Don't show placeholder in tables or lists
            for (let d = $from.depth; d > 0; d--) {
              const node = $from.node(d);
              if (
                node.type.name === 'table_cell' ||
                node.type.name === 'table_header' ||
                node.type.name === 'list_item' ||
                node.type.name === 'checkbox_item'
              ) {
                return DecorationSet.empty;
              }
            }

            const isFirstAndOnly = doc.childCount === 1;
            const text = isFirstAndOnly
              ? "Start writing, or type '/' for commands..."
              : "Type '/' for commands...";

            const hostDecoration = Decoration.node($from.before(), $from.after(), {
              class: 'easyview-placeholder-host',
              'data-placeholder': text,
            });

            return DecorationSet.create(doc, [hostDecoration]);
          }

          return DecorationSet.empty;
        },
      },
    });
  }

  private plusButtonPlugin(): Plugin {
    return new Plugin({
      key: new PluginKey('plusButton'),
      props: {
        decorations(state: EditorState) {
          const { $from, empty } = state.selection as any;

          if (!empty) return DecorationSet.empty;

          if (
            $from.parent.type.name === 'paragraph' &&
            $from.parent.content.size === 0
          ) {
            if ($from.depth === 1) {
              const widget = Decoration.widget(
                $from.pos,
                (view) => {
                  const btn = document.createElement('button');
                  btn.className = 'plus-button';
                  btn.contentEditable = 'false';
                  btn.innerHTML =
                    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
                  btn.title = 'Insert block';
                  btn.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const { slashMenuKey } = require('../slash-menu/SlashMenu');
                    const tr = view.state.tr.setMeta(slashMenuKey, {
                      openMenu: true,
                    });
                    view.dispatch(tr);
                    view.focus();
                  });
                  return btn;
                },
                { side: -1 }
              );

              return DecorationSet.create(state.doc, [widget]);
            }
          }

          return DecorationSet.empty;
        },
      },
    });
  }
}
