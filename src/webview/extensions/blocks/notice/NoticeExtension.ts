/**
 * NoticeExtension
 *
 * Handles notice/callout nodes (note, tip, important, caution, warning).
 * Schema node, keymaps, and serializer.
 */

import type { NodeSpec, Schema } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import { wrapInBlockSmart, liftFromNodeType } from '../../../editor/EditorCommands';

// ─── Notice Extension ────────────────────────────────────────────────────────

export class NoticeExtension extends Extension {
  get name() {
    return 'notice';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      notice: {
        attrs: {
          style: { default: 'note', validate: 'string' },
        },
        content: 'block+',
        group: 'block',
        defining: true,
        parseDOM: [
          {
            tag: 'div.notice-block',
            getAttrs(dom: HTMLElement) {
              return { style: dom.dataset.style || 'note' };
            },
          },
          // Standard HTML: <blockquote> with first child <p>[!type]</p>
          {
            tag: 'blockquote',
            priority: 60,
            getAttrs(dom: HTMLElement) {
              const firstP = dom.querySelector(':scope > p:first-child');
              if (!firstP) return false;
              const match = firstP.textContent?.match(/^\[!(\w+)\]$/);
              if (!match) return false;
              return { style: match[1].toLowerCase() };
            },
          },
        ],
        toDOM(node) {
          return [
            'div',
            { class: `notice-block notice-${node.attrs.style}`, 'data-style': node.attrs.style },
            0,
          ];
        },
      },
    };
  }

  keymaps(schema: Schema): Record<string, Command> {
    const toggleNote: Command = (state, dispatch) => {
      const { $from } = state.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type === schema.nodes.notice && node.attrs.style === 'note') {
          return liftFromNodeType(schema.nodes.notice)(state, dispatch);
        }
      }
      return wrapInBlockSmart(schema.nodes.notice, { style: 'note' })(state, dispatch);
    };
    return { 'Ctrl-Shift-n': toggleNote };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      notice(state, node) {
        const style = node.attrs.style || 'note';
        state.write(`> [!${style}]\n`);
        state.wrapBlock('> ', null, node, () => state.renderContent(node));
      },
    };
  }
}
