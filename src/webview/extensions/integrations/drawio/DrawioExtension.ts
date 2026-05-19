/**
 * DrawioExtension
 *
 * Handles Draw.io embed block nodes.
 */

import type { NodeSpec } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';

// ─── Drawio Extension ────────────────────────────────────────────────────────

export class DrawioExtension extends Extension {
  get name() {
    return 'drawio';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      drawio: {
        attrs: {
          src: { default: '', validate: 'string' },
          title: { default: 'Draw.io Diagram' },
        },
        group: 'block',
        atom: true,
        draggable: true,
        parseDOM: [
          {
            tag: 'div[data-type="drawio"]',
            getAttrs(dom: HTMLDivElement) {
              return {
                src: dom.dataset.src || '',
                title: dom.dataset.title || 'Draw.io Diagram',
              };
            },
          },
        ],
        toDOM(node) {
          return [
            'div',
            {
              'data-type': 'drawio',
              'data-src': node.attrs.src,
              'data-title': node.attrs.title,
              class: 'drawio-block',
              contenteditable: 'false',
            },
            ['div', { class: 'drawio-block-label' }, node.attrs.title || 'Draw.io Diagram'],
            ['div', { class: 'drawio-block-placeholder' }, 'Click to edit in Draw.io'],
          ];
        },
      },
    };
  }
}
