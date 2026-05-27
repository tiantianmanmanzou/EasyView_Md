/**
 * KeyboardOverridesExtension
 *
 * Handles keyboard events that need special handling in VS Code webview:
 * - GapCursor + Enter → insert paragraph
 * - Prevent double Enter in VS Code webview
 * - Prevent Tab from leaving editor in lists
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { BlockEdgeCursor } from '../block-edge-cursor/BlockEdgeCursor';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';

export class KeyboardOverridesExtension extends Extension {
  get name() {
    return 'keyboardOverrides';
  }

  private isInsideListContext(view: EditorView, schema: Schema): boolean {
    const { $from } = view.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const nodeType = $from.node(d).type;
      if (nodeType === schema.nodes.list_item || nodeType === schema.nodes.checkbox_item) {
        return true;
      }
    }

    return false;
  }

  plugins(schema: Schema): Plugin[] {
    let enterPressed = false;
    let resetTimeout: ReturnType<typeof setTimeout> | null = null;
    const isInsideListContext = (view: EditorView) => this.isInsideListContext(view, schema);

    return [
      new Plugin({
        key: new PluginKey('keyboardOverrides'),
        props: {
          handleKeyDown(view, event) {
            // Check for BlockEdgeCursor (our custom block edge cursor)
            const isGapCursor =
              view.state.selection instanceof BlockEdgeCursor ||
              (view.state.selection as any).jsonID === 'blockEdgeCursor';

            // GapCursor + Enter: insert a paragraph and move cursor into it
            if (isGapCursor && event.key === 'Enter') {
              const pos = view.state.selection.from;
              const tr = view.state.tr.insert(pos, schema.nodes.paragraph.create({}));
              tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1)));
              view.dispatch(tr);
              return true;
            }

            // GapCursor + Backspace/Delete: delete the adjacent block node
            if (isGapCursor && (event.key === 'Backspace' || event.key === 'Delete')) {
              const { $from } = view.state.selection;

              if (event.key === 'Backspace') {
                const before = $from.nodeBefore;
                if (before) {
                  const from = $from.pos - before.nodeSize;
                  const tr = view.state.tr.delete(from, $from.pos);
                  view.dispatch(tr);
                  return true;
                }
              }

              if (event.key === 'Delete') {
                const after = $from.nodeAfter;
                if (after) {
                  const tr = view.state.tr.delete($from.pos, $from.pos + after.nodeSize);
                  view.dispatch(tr);
                  return true;
                }
              }

              return true; // block event even if nothing to delete
            }

            // Prevent double Enter in VSCode webview
            if (event.code === 'Enter' && !event.shiftKey) {
              if (isInsideListContext(view)) {
                enterPressed = false;
                if (resetTimeout) {
                  clearTimeout(resetTimeout);
                  resetTimeout = null;
                }
                return false;
              }

              if (enterPressed) {
                event.preventDefault();
                event.stopPropagation();
                return true;
              }

              enterPressed = true;
              if (resetTimeout) {
                clearTimeout(resetTimeout);
              }
              resetTimeout = setTimeout(() => {
                enterPressed = false;
                resetTimeout = null;
              }, 100);
            }

            // ArrowUp: navigate to START of previous block when at the start of a textblock
            if (event.key === 'ArrowUp' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
              const { $from, empty: selEmpty } = view.state.selection;
              if (selEmpty && $from.parentOffset === 0) {
                const start = $from.start($from.depth);
                if (start > 1) {
                  try {
                    const $between = view.state.doc.resolve(start - 1);
                    const prevNode = $between.nodeBefore;
                    if (prevNode && prevNode.isTextblock) {
                      // Go to START of previous textblock
                      const prevContentStart = $between.pos - prevNode.nodeSize + 1;
                      const sel = TextSelection.create(view.state.doc, prevContentStart);
                      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
                      return true;
                    }
                    // Non-textblock (image, hr, etc.) — use near for best fit
                    const sel = TextSelection.near($between, -1);
                    if (sel.from !== $from.pos) {
                      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
                      return true;
                    }
                  } catch { /* fall through to PM */ }
                }
                // Try parent level for nested blocks (e.g. list items)
                if ($from.depth > 1) {
                  const parentStart = $from.start($from.depth - 1);
                  if (parentStart > 1) {
                    try {
                      const $between = view.state.doc.resolve(parentStart - 1);
                      const prevNode = $between.nodeBefore;
                      if (prevNode && prevNode.isTextblock) {
                        const prevContentStart = $between.pos - prevNode.nodeSize + 1;
                        const sel = TextSelection.create(view.state.doc, prevContentStart);
                        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
                        return true;
                      }
                      const sel = TextSelection.near($between, -1);
                      if (sel.from !== $from.pos) {
                        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
                        return true;
                      }
                    } catch { /* fall through to PM */ }
                  }
                }
              }
            }

            // Prevent Tab from leaving editor when in a list
            if (event.code === 'Tab') {
              const { $from } = view.state.selection;
              for (let d = $from.depth; d > 0; d--) {
                const node = $from.node(d);
                if (
                  node.type === schema.nodes.list_item ||
                  node.type === schema.nodes.checkbox_item
                ) {
                  event.preventDefault();
                  return false; // Let keymap handle Tab
                }
              }
            }

            return false;
          },
        },
      }),
    ];
  }
}
