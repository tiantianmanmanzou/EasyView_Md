/**
 * BlockEdgeCursorExtension
 *
 * Replaces prosemirror-gapcursor with a custom system that:
 * 1. Shows cursor at block edges when only ONE side is a gap-requiring node
 * 2. Renders cursor as a vertical line at the edge of the adjacent block,
 *    spanning the block's full height
 * 3. Side depends on how cursor was placed:
 *    - Click above midpoint → RIGHT edge of block before
 *    - Click below midpoint → LEFT edge of block after
 *    - ArrowDown → LEFT edge of block after
 *    - ArrowUp → RIGHT edge of block before
 */

import {
  Plugin,
  PluginKey,
  TextSelection,
  NodeSelection,
} from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { Fragment, Slice } from 'prosemirror-model';
import type { Schema } from 'prosemirror-model';
import { keydownHandler } from 'prosemirror-keymap';
import { Extension } from '../../../editor/EditorExtension';
import { BlockEdgeCursor } from './BlockEdgeCursor';
import { isValidBlockEdge, findBlockEdgeFrom } from './blockEdgeUtils';
import { _isMouseDragging } from '../../../editor/EditorCore';

// Plugin state: which side to render the cursor on
// 'after'  = cursor is after the block before  → RIGHT edge of nodeBefore
// 'before' = cursor is before the block after  → LEFT edge of nodeAfter
type CursorSide = 'before' | 'after';

interface BlockEdgeCursorState {
  side: CursorSide;
}

const blockEdgeCursorKey = new PluginKey<BlockEdgeCursorState>('blockEdgeCursor');
const BLOCK_EDGE_TEXT_INPUT_TYPES = new Set([
  'insertText',
  'insertCompositionText',
  'insertFromComposition',
  'insertReplacementText',
]);

export class BlockEdgeCursorExtension extends Extension {
  get name() {
    return 'blockEdgeCursor';
  }

  plugins(_schema: Schema): Plugin[] {
    return [blockEdgeCursorPlugin()];
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

function blockEdgeCursorPlugin(): Plugin<BlockEdgeCursorState> {
  const arrowKeyHandler = keydownHandler({
    ArrowLeft: arrow('horiz', -1),
    ArrowRight: arrow('horiz', 1),
    ArrowUp: arrow('vert', -1),
    ArrowDown: arrow('vert', 1),
  });

  return new Plugin<BlockEdgeCursorState>({
    key: blockEdgeCursorKey,

    state: {
      init() {
        return { side: 'before' };
      },
      apply(tr, prev) {
        const meta = tr.getMeta(blockEdgeCursorKey);
        if (meta) return meta;
        return prev;
      },
    },

    props: {
      createSelectionBetween(view: EditorView, $anchor, $head) {
        // Don't create BlockEdgeCursor if user is clicking away from an existing one
        if (view.state.selection instanceof BlockEdgeCursor) return null;
        return $anchor.pos === $head.pos && isValidBlockEdge($head)
          ? new BlockEdgeCursor($head)
          : null;
      },

      handleClick(view: EditorView, pos: number, event: MouseEvent) {
        if (!view || !view.editable) return false;
        const $pos = view.state.doc.resolve(pos);

        // Dead zone detection: click resolved inside a gap-requiring block
        // (table, code_block, etc.) but coordinates are outside its visual
        // bounds → redirect to the block edge cursor at the gap position
        if (!isValidBlockEdge($pos)) {
          for (let d = $pos.depth; d > 0; d--) {
            const ancestor = $pos.node(d);
            if (!(ancestor.type.isAtom || !!ancestor.type.spec.isolating)) continue;

            const ancestorStart = $pos.before(d);
            const ancestorRect = getVisualRect(view, ancestorStart);
            if (!ancestorRect) continue;

            // Click is to the right of the block → gap after
            if (event.clientX > ancestorRect.right + 2) {
              const gapPos = ancestorStart + ancestor.nodeSize;
              if (gapPos <= view.state.doc.content.size) {
                const $gap = view.state.doc.resolve(gapPos);
                if (isValidBlockEdge($gap)) {
                  const tr = view.state.tr.setSelection(new BlockEdgeCursor($gap));
                  tr.setMeta(blockEdgeCursorKey, { side: 'after' });
                  view.dispatch(tr);
                  return true;
                }
              }
            }

            // Click is to the left of the block → gap before
            if (event.clientX < ancestorRect.left - 2) {
              const $gap = view.state.doc.resolve(ancestorStart);
              if (isValidBlockEdge($gap)) {
                const tr = view.state.tr.setSelection(new BlockEdgeCursor($gap));
                tr.setMeta(blockEdgeCursorKey, { side: 'before' });
                view.dispatch(tr);
                return true;
              }
            }

            break; // Only check innermost gap-requiring ancestor
          }

          // When exiting BlockEdgeCursor by clicking on text, explicitly
          // set TextSelection — the invisible (visible=false) cursor has
          // no DOM selection, so ProseMirror's default handler can't
          // resolve the click to a TextSelection on the first attempt.
          if (view.state.selection instanceof BlockEdgeCursor) {
            const tr = view.state.tr.setSelection(TextSelection.near($pos));
            view.dispatch(tr);
            return true;
          }

          return false;
        }

        // Don't steal clicks from selectable nodes
        const clickPos = view.posAtCoords({
          left: event.clientX,
          top: event.clientY,
        });
        if (
          clickPos &&
          clickPos.inside > -1 &&
          NodeSelection.isSelectable(view.state.doc.nodeAt(clickPos.inside)!)
        ) {
          return false;
        }

        // Determine side based on click Y position
        let side: CursorSide = 'before';
        const nodeBefore = $pos.nodeBefore;
        const nodeAfter = $pos.nodeAfter;

        if (nodeBefore && nodeAfter) {
          const beforeRect = getVisualRect(view, pos - nodeBefore.nodeSize);
          const afterRect = getVisualRect(view, pos);
          if (beforeRect && afterRect) {
            const midpoint = (beforeRect.bottom + afterRect.top) / 2;
            side = event.clientY < midpoint ? 'after' : 'before';
          }
        } else if (!nodeAfter && nodeBefore) {
          side = 'after';
        }

        const tr = view.state.tr.setSelection(new BlockEdgeCursor($pos));
        tr.setMeta(blockEdgeCursorKey, { side });
        view.dispatch(tr);
        return true;
      },

      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        if (shouldPrepareBlockEdgeForTyping(view, event)) {
          materializeTextCursorFromBlockEdge(view);
          return false;
        }

        return arrowKeyHandler(view, event);
      },
      handleTextInput(view: EditorView, _from: number, _to: number, text: string) {
        if (!(view.state.selection instanceof BlockEdgeCursor)) return false;
        if (!materializeTextCursorFromBlockEdge(view)) return false;

        const selection = view.state.selection;
        if (!(selection instanceof TextSelection) || !selection.empty) {
          return false;
        }

        const insertPos = selection.from;
        view.dispatch(
          view.state.tr.insertText(text, insertPos, insertPos)
        );
        return true;
      },

      handleDOMEvents: {
        compositionstart(view: EditorView) {
          if (!(view.state.selection instanceof BlockEdgeCursor)) return false;
          materializeTextCursorFromBlockEdge(view);
          return false;
        },
        mousedown(view: EditorView, event: MouseEvent) {
          if (!(view.state.selection instanceof BlockEdgeCursor)) return false;
          const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!coords) return false;
          const $pos = view.state.doc.resolve(coords.pos);
          if (!isValidBlockEdge($pos)) {
            // Clicking on text/non-edge — dismiss BlockEdgeCursor immediately
            const tr = view.state.tr.setSelection(TextSelection.near($pos));
            view.dispatch(tr);
            view.focus();
            return true;
          }
          return false;
        },
        beforeinput(view: EditorView, event: InputEvent) {
          if (
            !BLOCK_EDGE_TEXT_INPUT_TYPES.has(event.inputType) ||
            !(view.state.selection instanceof BlockEdgeCursor)
          ) {
            return false;
          }

          materializeTextCursorFromBlockEdge(view);
          return false;
        },
      },
    },

    view(editorView: EditorView) {
      return new BlockEdgeCursorView(editorView);
    },
  });
}

function shouldPrepareBlockEdgeForTyping(view: EditorView, event: KeyboardEvent): boolean {
  if (!(view.state.selection instanceof BlockEdgeCursor)) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.isComposing || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229;
}

function materializeTextCursorFromBlockEdge(view: EditorView): boolean {
  if (!(view.state.selection instanceof BlockEdgeCursor)) return false;

  const { $from } = view.state.selection;
  const insert = $from.parent
    .contentMatchAt($from.index())
    .findWrapping(view.state.schema.nodes.text);
  if (!insert) return false;

  let frag = Fragment.empty;
  for (let index = insert.length - 1; index >= 0; index--) {
    frag = Fragment.from(insert[index].createAndFill(null, frag));
  }

  const tr = view.state.tr.replace(
    $from.pos,
    $from.pos,
    new Slice(frag, 0, 0)
  );
  tr.setSelection(TextSelection.near(tr.doc.resolve($from.pos + 1)));
  view.dispatch(tr);
  if (!view.hasFocus()) {
    view.focus();
  }
  return true;
}

// ─── Visual rect helper ──────────────────────────────────────────────────────

/**
 * Get the visual bounding rect for a node at `pos`.
 * Expands VERTICALLY to include adjacent content widget decorations
 * (e.g. mermaid diagram SVGs), but keeps horizontal bounds from the
 * node's own DOM to avoid full-width widget issues.
 */
function getVisualRect(view: EditorView, pos: number): DOMRect | null {
  try {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return null;

    const nodeRect = dom.getBoundingClientRect();

    // Expand vertically to include adjacent content widget decorations
    // (skip small UI widgets like drag handles, threshold 30px)
    let top = nodeRect.top;
    let bottom = nodeRect.bottom;

    let sibling = dom.nextElementSibling;
    while (sibling instanceof HTMLElement && sibling.classList.contains('ProseMirror-widget')) {
      const sibRect = sibling.getBoundingClientRect();
      if (sibRect.height > 30) {
        top = Math.min(top, sibRect.top);
        bottom = Math.max(bottom, sibRect.bottom);
      }
      sibling = sibling.nextElementSibling;
    }

    // Keep horizontal from node rect, use expanded vertical
    return new DOMRect(nodeRect.left, top, nodeRect.width, bottom - top);
  } catch (_) {
    return null;
  }
}

// ─── Overlay view ─────────────────────────────────────────────────────────────

class BlockEdgeCursorView {
  private element: HTMLElement | null = null;
  private container: HTMLElement;
  private editorView: EditorView;

  constructor(view: EditorView) {
    this.editorView = view;
    this.container = view.dom.parentElement || view.dom;
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }
    this.updateCursor(view);
  }

  update(view: EditorView) {
    this.editorView = view;
    // Skip DOM mutations during mouse drag to preserve native selection
    if (_isMouseDragging) return;
    this.updateCursor(view);
  }

  destroy() {
    this.removeCursor();
    this.editorView.dom.classList.remove('block-edge-cursor-active');
  }

  private updateCursor(view: EditorView) {
    const sel = view.state.selection;
    // Wrap DOM mutations in domObserver.stop()/start() to prevent
    // MutationObserver from seeing our changes and triggering re-processing.
    const obs = (view as any).domObserver;
    obs?.stop();
    if (!(sel instanceof BlockEdgeCursor) || !view.hasFocus()) {
      this.removeCursor();
      view.dom.classList.remove('block-edge-cursor-active');
      obs?.start();
      return;
    }
    view.dom.classList.add('block-edge-cursor-active');
    this.renderOverlay(view, sel);
    obs?.start();
  }

  private removeCursor() {
    if (this.element) {
      this.element.remove();
      this.element = null;
    }
  }

  private renderOverlay(view: EditorView, sel: BlockEdgeCursor) {
    const $pos = sel.$head;
    const pos = $pos.pos;
    const nodeBefore = $pos.nodeBefore;
    const nodeAfter = $pos.nodeAfter;

    // Read side from plugin state
    const pluginState = blockEdgeCursorKey.getState(view.state);
    const side: CursorSide = pluginState?.side || 'before';

    let blockRect: DOMRect | null = null;
    let atRightEdge = false;

    if (side === 'after' && nodeBefore) {
      blockRect = getVisualRect(view, pos - nodeBefore.nodeSize);
      atRightEdge = true;
    }

    if (!blockRect && side === 'before' && nodeAfter) {
      blockRect = getVisualRect(view, pos);
      atRightEdge = false;
    }

    // Fallback if preferred side didn't work
    if (!blockRect && nodeBefore) {
      blockRect = getVisualRect(view, pos - nodeBefore.nodeSize);
      atRightEdge = true;
    }
    if (!blockRect && nodeAfter) {
      blockRect = getVisualRect(view, pos);
      atRightEdge = false;
    }

    if (!blockRect) {
      this.removeCursor();
      return;
    }

    const containerRect = this.container.getBoundingClientRect();

    const cursorWidth = 2;
    const top = blockRect.top - containerRect.top;
    const height = blockRect.height;
    const left = atRightEdge
      ? blockRect.right - containerRect.left - cursorWidth
      : blockRect.left - containerRect.left;

    if (!this.element) {
      this.element = this.container.appendChild(document.createElement('div'));
      this.element.className = 'block-edge-cursor';
    }

    this.element.style.top = `${top}px`;
    this.element.style.left = `${left}px`;
    this.element.style.width = `${cursorWidth}px`;
    this.element.style.height = `${height}px`;
  }
}

// ─── Arrow key handler ────────────────────────────────────────────────────────

function arrow(axis: 'horiz' | 'vert', dir: number) {
  const dirStr =
    axis === 'vert'
      ? dir > 0 ? 'down' : 'up'
      : dir > 0 ? 'right' : 'left';

  // ArrowDown/Right → entering gap from above → side = 'before' (LEFT edge of next block)
  // ArrowUp/Left → entering gap from below → side = 'after' (RIGHT edge of prev block)
  const side: CursorSide = dir > 0 ? 'before' : 'after';

  return function (
    state: any,
    dispatch: any,
    view: EditorView
  ): boolean {
    const sel = state.selection;
    const $start = dir > 0 ? sel.$to : sel.$from;
    let mustMove = sel.empty;

    if (sel instanceof TextSelection) {
      if (!view.endOfTextblock(dirStr as any) || $start.depth === 0) {
        return false;
      }
      mustMove = false;
      const resolved = state.doc.resolve(
        dir > 0 ? $start.after() : $start.before()
      );
      const $found = findBlockEdgeFrom(resolved, dir, mustMove);
      if (!$found) return false;
      if (dispatch) {
        const tr = state.tr.setSelection(new BlockEdgeCursor($found));
        tr.setMeta(blockEdgeCursorKey, { side });
        dispatch(tr);
      }
      return true;
    }

    const $found = findBlockEdgeFrom($start, dir, mustMove);
    if (!$found) return false;
    if (dispatch) {
      const tr = state.tr.setSelection(new BlockEdgeCursor($found));
      tr.setMeta(blockEdgeCursorKey, { side });
      dispatch(tr);
    }
    return true;
  };
}
