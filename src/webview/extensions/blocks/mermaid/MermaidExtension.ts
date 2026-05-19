/**
 * MermaidExtension
 *
 * Provides the mermaid diagram node and rendering plugin.
 * Supports dark theme detection via isDark parameter.
 */

import type { Plugin } from 'prosemirror-state';
import type { NodeSpec, Schema } from 'prosemirror-model';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import Mermaid from './MermaidPlugin';

// ─── Mermaid Extension ───────────────────────────────────────────────────────

export class MermaidExtension extends Extension {
  private isDark: boolean;

  constructor(isDark = false) {
    super();
    this.isDark = isDark;
  }

  get name() {
    return 'mermaid';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      mermaid: {
        attrs: {
          content: { default: '', validate: 'string' },
        },
        group: 'block',
        atom: true,
        draggable: true,
        parseDOM: [
          {
            tag: 'div[data-type="mermaid"]',
            getAttrs(dom: HTMLDivElement) {
              return { content: dom.dataset.content || dom.textContent || '' };
            },
          },
        ],
        toDOM(node) {
          return [
            'div',
            {
              'data-type': 'mermaid',
              'data-content': node.attrs.content,
              class: 'mermaid-block',
              contenteditable: 'false',
            },
            ['div', { class: 'mermaid-block-label' }, 'Mermaid Diagram'],
            ['pre', { class: 'mermaid-block-code' }, node.attrs.content || 'graph TD\n  A-->B'],
          ];
        },
      },
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      mermaid(state, node) {
        state.write('```mermaid\n');
        state.text(node.attrs.content || '', false);
        state.write('\n```');
        state.closeBlock(node);
      },
    };
  }

  plugins(_schema: Schema): Plugin[] {
    return [
      Mermaid({ isDark: this.isDark }),
    ];
  }
}
