/**
 * DescriptionListExtension — Definition lists (dl/dt/dd)
 *
 * GitLab syntax:
 *   Term
 *   :   Definition
 *
 * Uses markdown-it-deflist for parsing.
 *
 * Schema nodes are defined in EditorSchema.ts.
 * Parsing rules are in MarkdownParser.ts (markdown-it-deflist plugin).
 * Serialization is in MarkdownSerializer.ts.
 */

import type { EditorView } from 'prosemirror-view';
import { Extension, type SlashMenuItem } from '../../../editor/EditorExtension';

export class DescriptionListExtension extends Extension {
  get name() {
    return 'description-list';
  }

  get slashMenuItems(): SlashMenuItem[] {
    return [
      {
        label: 'Description list',
        keywords: ['description', 'definition', 'term', 'glossary', 'dl', 'dt', 'dd'],
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
        group: 'insert',
        action(view: EditorView) {
          const { state, dispatch } = view;
          const { schema } = state;
          const term = schema.nodes.description_term.create(null, schema.text('Term'));
          const detail = schema.nodes.description_detail.create(
            null,
            schema.nodes.paragraph.create(null, schema.text('Definition'))
          );
          const dl = schema.nodes.description_list.create(null, [term, detail]);
          dispatch(state.tr.replaceSelectionWith(dl).scrollIntoView());
          view.focus();
        },
      },
    ];
  }
}
