/**
 * FootnotesExtension — Footnote references [^label] and definitions [^label]: text
 *
 * Uses markdown-it-footnote for parsing. Supports:
 * - Named labels: [^note], [^1], [^my-ref]
 * - Multi-paragraph definitions (4-space indented continuation)
 * - Inline footnotes ^[text] (auto-converted to regular footnotes)
 *
 * Schema nodes are defined in EditorSchema.ts.
 * Parsing rules are in MarkdownParser.ts (markdown-it-footnote + cleanup core rule).
 * Serialization is in MarkdownSerializer.ts.
 *
 * Includes a plugin that auto-deletes orphaned footnote_def nodes
 * when their matching footnote_ref is removed from the document.
 */

import type { Schema } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Extension } from '../../../editor/EditorExtension';

export class FootnotesExtension extends Extension {
  get name() {
    return 'footnotes';
  }

  plugins(_schema: Schema): Plugin[] {
    return [footnoteCleanupPlugin()];
  }
}

// ─── Plugin: Auto-delete orphaned footnote definitions ───────────────────────

const footnoteCleanupKey = new PluginKey('footnoteCleanup');

function footnoteCleanupPlugin(): Plugin {
  return new Plugin({
    key: footnoteCleanupKey,
    appendTransaction(transactions, _oldState, newState) {
      // Only run when the document actually changed
      const docChanged = transactions.some(tr => tr.docChanged);
      if (!docChanged) return null;

      // Collect all footnote_ref labels in the document
      const refLabels = new Set<string>();
      newState.doc.descendants((node) => {
        if (node.type.name === 'footnote_ref') {
          refLabels.add(node.attrs.label);
        }
      });

      // Find orphaned footnote_def nodes (no matching ref)
      const orphans: { pos: number; size: number }[] = [];
      newState.doc.descendants((node, pos) => {
        if (node.type.name === 'footnote_def') {
          if (!refLabels.has(node.attrs.label)) {
            orphans.push({ pos, size: node.nodeSize });
          }
        }
      });

      if (orphans.length === 0) return null;

      // Delete orphans in reverse order (to keep positions stable)
      let tr = newState.tr;
      for (let i = orphans.length - 1; i >= 0; i--) {
        const { pos, size } = orphans[i];
        tr = tr.delete(pos, pos + size);
      }

      return tr;
    },
  });
}
