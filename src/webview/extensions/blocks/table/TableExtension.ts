/**
 * TableExtension
 *
 * Provides table schema nodes, editing plugins (prosemirror-tables),
 * grip selection tracking, focus class management, and serializer.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { NodeSpec, Schema } from 'prosemirror-model';
import type { NodeViewConstructor } from 'prosemirror-view';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { tableEditing } from 'prosemirror-tables';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import { gripSelectionPlugin } from './GripSelectionPlugin';
import { tableKeywordsPlugin } from './TableKeywordsPlugin';
import { TableView } from './TableView';

// ─── Table Extension ─────────────────────────────────────────────────────────

export class TableExtension extends Extension {
  get name() {
    return 'table';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      table: {
        content: 'table_row+',
        group: 'block',
        isolating: true,
        tableRole: 'table',
        parseDOM: [{ tag: 'table' }],
        toDOM() {
          return ['div', { class: 'table-wrapper' }, ['table', ['tbody', 0]]];
        },
      },
      table_row: {
        content: '(table_cell | table_header)*',
        tableRole: 'row',
        parseDOM: [{ tag: 'tr' }],
        toDOM() {
          return ['tr', 0];
        },
      },
      table_cell: {
        attrs: {
          colspan: { default: 1, validate: 'number' },
          rowspan: { default: 1, validate: 'number' },
          alignment: { default: null },
        },
        content: 'block+',
        tableRole: 'cell',
        isolating: true,
        parseDOM: [
          {
            tag: 'td',
            getAttrs(dom: HTMLTableCellElement) {
              return {
                colspan: dom.colSpan,
                rowspan: dom.rowSpan,
                alignment: dom.style.textAlign || null,
              };
            },
          },
        ],
        toDOM(node) {
          const attrs: Record<string, any> = {};
          if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
          if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
          if (node.attrs.alignment) attrs.style = `text-align: ${node.attrs.alignment}`;
          return ['td', attrs, 0];
        },
      },
      table_header: {
        attrs: {
          colspan: { default: 1, validate: 'number' },
          rowspan: { default: 1, validate: 'number' },
          alignment: { default: null },
        },
        content: 'block+',
        tableRole: 'header_cell',
        isolating: true,
        parseDOM: [
          {
            tag: 'th',
            getAttrs(dom: HTMLTableCellElement) {
              return {
                colspan: dom.colSpan,
                rowspan: dom.rowSpan,
                alignment: dom.style.textAlign || null,
              };
            },
          },
        ],
        toDOM(node) {
          const attrs: Record<string, any> = {};
          if (node.attrs.colspan !== 1) attrs.colspan = node.attrs.colspan;
          if (node.attrs.rowspan !== 1) attrs.rowspan = node.attrs.rowspan;
          if (node.attrs.alignment) attrs.style = `text-align: ${node.attrs.alignment}`;
          return ['th', attrs, 0];
        },
      },
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      // Table serialization is complex and handled by the existing serializer.
      // These are placeholder handlers — the actual serialization logic
      // (markdown pipe tables / HTML tables) is in serializer.ts's serializeTable.
      table_row: () => {},
      table_cell: () => {},
      table_header: () => {},
    };
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      table: (node) => new TableView(node, 25),
    };
  }

  plugins(_schema: Schema): Plugin[] {
    return [
      tableEditing(),
      this.tableFocusPlugin(),
      gripSelectionPlugin(),
      tableKeywordsPlugin(),
    ];
  }

  // ── Private: Table Focus Plugin ──

  /**
   * Adds .has-focus class to the table node when the caret is inside it.
   * Uses Decoration.node() instead of direct DOM mutation to avoid
   * triggering ProseMirror's MutationObserver → transaction loop.
   */
  private tableFocusPlugin(): Plugin {
    const key = new PluginKey('tableFocus');

    function findFocusedTable(state: import('prosemirror-state').EditorState): { pos: number; node: import('prosemirror-model').Node } | null {
      const { $from } = state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const node = $from.node(d);
        if (node.type.name === 'table') {
          return { pos: $from.before(d), node };
        }
      }
      return null;
    }

    return new Plugin({
      key,
      state: {
        init(_, state) {
          const found = findFocusedTable(state);
          if (!found) return DecorationSet.empty;
          return DecorationSet.create(state.doc, [
            Decoration.node(found.pos, found.pos + found.node.nodeSize, { class: 'has-focus' }),
          ]);
        },
        apply(tr, decorationSet, _oldState, newState) {
          if (!tr.docChanged && !tr.selectionSet) return decorationSet;
          const found = findFocusedTable(newState);
          if (!found) return DecorationSet.empty;
          return DecorationSet.create(newState.doc, [
            Decoration.node(found.pos, found.pos + found.node.nodeSize, { class: 'has-focus' }),
          ]);
        },
      },
      props: {
        decorations(state) {
          return key.getState(state);
        },
      },
    });
  }
}
