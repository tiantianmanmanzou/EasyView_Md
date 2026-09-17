/**
 * TableKeywordsPlugin
 *
 * Highlights standalone keywords (TRUE, FALSE, NULL, etc.) in table cells
 * with colored badge decorations. Only matches when the entire cell content
 * is a single keyword (trimmed).
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';

type BadgeColor = 'green' | 'red' | 'gray';

/** Case-insensitive keyword → color mapping */
const KEYWORDS_LOWER: Record<string, BadgeColor> = {
  true: 'green',
  yes: 'green',
  да: 'green',
  false: 'red',
  no: 'red',
  нет: 'red',
  null: 'gray',
  'n/a': 'gray',
  na: 'gray',
  none: 'gray',
};

/** Exact-match keywords (case-sensitive, for symbols) */
const KEYWORDS_EXACT: Record<string, BadgeColor> = {
  '—': 'gray',
  '-': 'gray',
  '--': 'gray',
};

function getKeywordColor(text: string): BadgeColor | null {
  const exact = KEYWORDS_EXACT[text];
  if (exact) return exact;
  return KEYWORDS_LOWER[text.toLowerCase()] ?? null;
}

function createKeywordDecorations(doc: ProsemirrorNode): Decoration[] {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== 'table_cell' && node.type.name !== 'table_header') {
      return;
    }

    // Check if entire cell content is a single keyword
    const trimmed = node.textContent.trim();
    if (!trimmed) return false; // skip descending into cell children

    const color = getKeywordColor(trimmed);
    if (!color) return false;

    // Find the text node(s) inside the cell to wrap with inline decoration.
    // Cell structure: table_cell > paragraph > text
    node.descendants((child, childOffset) => {
      if (child.isText && child.text) {
        const text = child.text;
        // Only decorate non-whitespace portions
        const start = text.search(/\S/);
        const end = text.search(/\S\s*$/) + 1;
        if (start >= 0 && end > start) {
          const from = pos + childOffset + 1 + start;
          const to = pos + childOffset + 1 + end;
          decorations.push(
            Decoration.inline(from, to, { class: `table-kw table-kw-${color}` }),
          );
        }
      }
    });

    return false; // don't descend further (we already did manually)
  });

  return decorations;
}

export const tableKeywordsKey = new PluginKey<DecorationSet>('tableKeywords');

export function tableKeywordsPlugin(): Plugin {
  return new Plugin({
    key: tableKeywordsKey,
    state: {
      init(_, state) {
        return DecorationSet.create(state.doc, createKeywordDecorations(state.doc));
      },
      apply(tr, decorationSet, _oldState, newState) {
        if (!tr.docChanged) return decorationSet.map(tr.mapping, tr.doc);
        return DecorationSet.create(newState.doc, createKeywordDecorations(newState.doc));
      },
    },
    props: {
      decorations(state) {
        return tableKeywordsKey.getState(state);
      },
    },
  });
}
