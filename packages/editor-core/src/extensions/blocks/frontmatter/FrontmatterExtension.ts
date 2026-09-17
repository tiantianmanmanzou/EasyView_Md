/**
 * FrontmatterExtension
 *
 * Handles YAML frontmatter blocks at the start of markdown documents.
 * Wraps existing FrontmatterView for display/edit mode.
 */

import type { NodeViewConstructor } from 'prosemirror-view';
import type { NodeSpec } from 'prosemirror-model';
import { FrontmatterView } from './FrontmatterView';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

export class FrontmatterExtension extends Extension {
  get name() {
    return 'frontmatter';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      frontmatter: {
        content: 'text*',
        marks: '',
        code: true,
        defining: true,
        isolating: true,
        parseDOM: [
          {
            tag: 'pre.frontmatter',
            preserveWhitespace: 'full' as const,
          },
        ],
        toDOM() {
          return [
            'pre',
            { class: 'frontmatter' },
            ['code', 0],
          ];
        },
      },
    };
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      frontmatter: (node, view, getPos) => new FrontmatterView(node, view, getPos),
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      frontmatter(state, node) {
        const yamlText = node.textContent;
        state.write('---\n');
        state.text(yamlText, false);
        state.write('\n---');
        state.closeBlock(node);
      },
    };
  }
}
