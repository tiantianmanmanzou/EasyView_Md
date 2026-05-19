/**
 * MarkBoundaryExtension
 *
 * Allows the cursor to escape or enter inline marks (bold, italic, code, etc.)
 * at mark boundaries using ArrowLeft/ArrowRight.
 *
 * Problem: ProseMirror marks are inclusive by default. At the end of a bold
 * span, typing always produces bold text. At the start, you can't place the
 * cursor "inside" the mark to prepend.
 *
 * Solution: When the cursor is at a mark boundary, ArrowLeft/ArrowRight
 * toggle storedMarks to switch between inside/outside the mark. A thin
 * visual indicator shows the current state.
 */

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Schema, Mark } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';

// Marks that support boundary toggling (inclusive marks only)
const BOUNDARY_MARKS = new Set([
  'strong', 'em', 'underline', 'strikethrough', 'code_inline', 'highlight',
  'diff_add', 'diff_del', 'html_tag',
]);

interface BoundaryInfo {
  pos: number;
  /** 'start' = cursor at left edge of mark, 'end' = cursor at right edge */
  side: 'start' | 'end';
  /** The marks at the boundary */
  marks: readonly Mark[];
  /** Whether storedMarks currently include the boundary marks (cursor "inside") */
  inside: boolean;
}

function detectBoundary(state: import('prosemirror-state').EditorState): BoundaryInfo | null {
  const { selection } = state;
  if (!selection.empty || !(selection instanceof TextSelection)) return null;

  const $pos = selection.$from;
  const pos = $pos.pos;

  // Marks on the left and right of cursor position
  const marksBefore = $pos.marks();
  const marksAfter = $pos.nodeAfter
    ? $pos.nodeAfter.marks
    : [];

  // Find boundary marks (marks that exist on one side but not the other)
  const beforeSet = new Set(marksBefore.filter(m => BOUNDARY_MARKS.has(m.type.name)).map(m => m.type.name));
  const afterSet = new Set(marksAfter.filter(m => BOUNDARY_MARKS.has(m.type.name)).map(m => m.type.name));

  // Right boundary: mark exists before cursor but not after
  const exitingMarks = marksBefore.filter(m => BOUNDARY_MARKS.has(m.type.name) && !afterSet.has(m.type.name));
  if (exitingMarks.length > 0) {
    // Check if storedMarks are set (user toggled)
    const stored = state.storedMarks;
    const inside = stored
      ? exitingMarks.some(m => stored.some(s => s.type === m.type))
      : true; // by default, at end of mark = inside
    return { pos, side: 'end', marks: exitingMarks, inside };
  }

  // Left boundary: mark exists after cursor but not before
  const enteringMarks = marksAfter.filter(m => BOUNDARY_MARKS.has(m.type.name) && !beforeSet.has(m.type.name));
  if (enteringMarks.length > 0) {
    const stored = state.storedMarks;
    const inside = stored
      ? enteringMarks.some(m => stored.some(s => s.type === m.type))
      : false; // by default, at start of mark = outside
    return { pos, side: 'start', marks: enteringMarks, inside };
  }

  return null;
}

export class MarkBoundaryExtension extends Extension {
  get name() {
    return 'markBoundary';
  }

  plugins(_schema: Schema): Plugin[] {
    return [this.boundaryPlugin()];
  }

  private boundaryPlugin(): Plugin {
    const pluginKey = new PluginKey<DecorationSet>('markBoundary');

    let lastBoundaryKey = '';

    function buildDecorations(state: import('prosemirror-state').EditorState): DecorationSet {
      const boundary = detectBoundary(state);
      if (!boundary) {
        lastBoundaryKey = '';
        return DecorationSet.empty;
      }

      const key = `${boundary.pos}:${boundary.side}:${boundary.inside}`;
      lastBoundaryKey = key;

      // Add a thin space widget at the boundary.
      // Widget side flips based on inside/outside so the cursor appears
      // on the correct side of the gap: inside = next to text, outside = at boundary edge.
      const widgetSide = (boundary.side === 'end') === boundary.inside ? 1 : -1;
      const widget = Decoration.widget(
        boundary.pos,
        () => {
          const el = document.createElement('span');
          el.className = 'mark-boundary-gap';
          return el;
        },
        { side: widgetSide }
      );
      return DecorationSet.create(state.doc, [widget]);
    }

    return new Plugin({
      key: pluginKey,
      state: {
        init(_, state) {
          return buildDecorations(state);
        },
        apply(tr, decoSet, _oldState, newState) {
          if (tr.docChanged || tr.selectionSet || tr.storedMarksSet) {
            const boundary = detectBoundary(newState);
            const key = boundary ? `${boundary.pos}:${boundary.side}:${boundary.inside}` : '';
            if (key === lastBoundaryKey) return decoSet;
            return buildDecorations(newState);
          }
          return decoSet;
        },
      },
      props: {
        decorations(state) {
          return pluginKey.getState(state) ?? DecorationSet.empty;
        },
        handleKeyDown(view, event) {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return false;
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;

          const boundary = detectBoundary(view.state);
          if (!boundary) return false;

          // At end of mark: ArrowRight should exit mark (remove stored marks)
          if (boundary.side === 'end' && event.key === 'ArrowRight' && boundary.inside) {
            // Set stored marks to empty (no marks) to exit
            const tr = view.state.tr.setStoredMarks(
              view.state.storedMarks?.filter(m => !BOUNDARY_MARKS.has(m.type.name)) ?? []
            );
            view.dispatch(tr);

            return true;
          }

          // At end of mark: ArrowLeft should re-enter mark (restore marks)
          if (boundary.side === 'end' && event.key === 'ArrowLeft' && !boundary.inside) {
            const stored = [...(view.state.storedMarks ?? [])];
            for (const m of boundary.marks) {
              if (!stored.some(s => s.type === m.type)) {
                stored.push(m);
              }
            }
            const tr = view.state.tr.setStoredMarks(stored);
            view.dispatch(tr);

            return true;
          }

          // At start of mark: ArrowRight should enter mark (add stored marks)
          if (boundary.side === 'start' && event.key === 'ArrowRight' && !boundary.inside) {
            const stored = [...(view.state.storedMarks ?? view.state.selection.$from.marks())];
            for (const m of boundary.marks) {
              if (!stored.some(s => s.type === m.type)) {
                stored.push(m);
              }
            }
            const tr = view.state.tr.setStoredMarks(stored);
            view.dispatch(tr);

            return true;
          }

          // At start of mark: ArrowLeft should exit mark (remove marks)
          if (boundary.side === 'start' && event.key === 'ArrowLeft' && boundary.inside) {
            const tr = view.state.tr.setStoredMarks(
              view.state.storedMarks?.filter(m => !BOUNDARY_MARKS.has(m.type.name)) ?? []
            );
            view.dispatch(tr);

            return true;
          }

          return false;
        },
      },
    });
  }
}
