/**
 * ClipboardExtension
 *
 * Serializes clipboard content as markdown when copying.
 * Handles special cases for code blocks and table cells.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';
import { serializer } from '../../../editor/lib/MarkdownSerializer';

export class ClipboardExtension extends Extension {
  get name() {
    return 'clipboard';
  }

  plugins(schema: Schema): Plugin[] {
    return [
      new Plugin({
        key: new PluginKey('clipboardTextSerializer'),
        props: {
          clipboardTextSerializer(slice) {
            if (slice.content.childCount === 1) {
              const firstChild = slice.content.firstChild;

              // Handle code_block: return raw text
              if (firstChild?.type.name === 'code_block') {
                return firstChild.textContent;
              }

              // Handle single-cell table: extract cell content
              if (firstChild?.type.name === 'table') {
                const table = firstChild;
                if (table.childCount === 1) {
                  const row = table.firstChild;
                  if (row && row.childCount === 1) {
                    const cell = row.firstChild;
                    if (
                      cell &&
                      (cell.type.name === 'table_cell' ||
                        cell.type.name === 'table_header')
                    ) {
                      const cellDoc = schema.nodes.doc.create(
                        null,
                        cell.content
                      );
                      return serializer.serialize(cellDoc);
                    }
                  }
                }
              }
            }

            // Default: serialize entire slice as markdown
            const doc = schema.nodes.doc.create(null, slice.content);
            return serializer.serialize(doc);
          },
        },
      }),
    ];
  }
}
