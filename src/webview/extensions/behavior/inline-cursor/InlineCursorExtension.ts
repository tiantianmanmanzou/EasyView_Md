/**
 * InlineCursorExtension
 *
 * Renders a fake blinking cursor next to inline atom nodes (images)
 * where the native browser caret becomes invisible.
 *
 * Also highlights inline atoms (images) when they fall inside a text range
 * selection — like the native blue text highlight.
 */

import { Plugin, PluginKey, NodeSelection } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Schema } from 'prosemirror-model';
import { Extension } from '../../../editor/EditorExtension';
import { _isMouseDragging } from '../../../editor/EditorCore';

export class InlineCursorExtension extends Extension {
  get name() {
    return 'inlineCursor';
  }

  plugins(_schema: Schema): Plugin[] {
    return [this.cursorPlugin(), this.selectionPlugin()];
  }

  private cursorPlugin(): Plugin {
    const key = new PluginKey<DecorationSet>('inlineCursor');

    // Track the position where the cursor indicator is shown.
    // Only rebuild decorations when this changes — avoids DOM mutations
    // during mouse drag that break native selection extension.
    let lastIndicatorPos: number | null = null;
    let lastSide: number = 0;

    function computeIndicator(state: import('prosemirror-state').EditorState): { pos: number; side: number } | null {
      const { selection } = state;
      if (!selection.empty || selection instanceof NodeSelection) return null;

      const $pos = selection.$from;
      const nodeBefore = $pos.nodeBefore;
      const nodeAfter = $pos.nodeAfter;

      const nearAtom =
        (nodeBefore && nodeBefore.isInline && nodeBefore.isAtom) ||
        (nodeAfter && nodeAfter.isInline && nodeAfter.isAtom);

      if (!nearAtom) return null;
      return { pos: $pos.pos, side: nodeBefore?.isAtom ? 1 : -1 };
    }

    function buildDecorations(state: import('prosemirror-state').EditorState): DecorationSet {
      const info = computeIndicator(state);
      if (!info) {
        lastIndicatorPos = null;
        lastSide = 0;
        return DecorationSet.empty;
      }

      lastIndicatorPos = info.pos;
      lastSide = info.side;

      const widget = Decoration.widget(
        info.pos,
        () => {
          const el = document.createElement('span');
          el.className = 'inline-cursor-indicator';
          return el;
        },
        { side: info.side }
      );
      return DecorationSet.create(state.doc, [widget]);
    }

    return new Plugin({
      key,
      state: {
        init(_, state) {
          return buildDecorations(state);
        },
        apply(tr, decorationSet, _oldState, newState) {
          // Freeze decorations during mouse drag to prevent DOM mutations
          // that break native selection extension (collapse loop).
          if (_isMouseDragging) {
            return decorationSet;
          }
          if (tr.docChanged) {
            return buildDecorations(newState);
          }
          if (tr.selectionSet) {
            // Only rebuild if the indicator position/side actually changed
            const info = computeIndicator(newState);
            const newPos = info?.pos ?? null;
            const newSide = info?.side ?? 0;
            if (newPos === lastIndicatorPos && newSide === lastSide) {
              return decorationSet;
            }
            return buildDecorations(newState);
          }
          return decorationSet;
        },
      },
      props: {
        decorations(state) {
          return key.getState(state) ?? DecorationSet.empty;
        },
      },
    });
  }

  private selectionPlugin(): Plugin {
    const key = new PluginKey<DecorationSet>('imageSelection');

    // Track which image positions are highlighted to avoid unnecessary rebuilds.
    let lastImagePositions = '';

    function buildImageSelection(state: import('prosemirror-state').EditorState): DecorationSet {
      const { selection } = state;
      if (selection.empty || selection instanceof NodeSelection) {
        lastImagePositions = '';
        return DecorationSet.empty;
      }

      const { from, to } = selection;
      const decorations: Decoration[] = [];
      const positions: number[] = [];

      state.doc.nodesBetween(from, to, (node, pos) => {
        if (
          node.type.name === 'image' &&
          pos >= from &&
          pos + node.nodeSize <= to
        ) {
          positions.push(pos);
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: 'in-selection',
            })
          );
        }
      });

      lastImagePositions = positions.join(',');
      if (decorations.length === 0) return DecorationSet.empty;
      return DecorationSet.create(state.doc, decorations);
    }

    return new Plugin({
      key,
      state: {
        init(_, state) {
          return buildImageSelection(state);
        },
        apply(tr, decorationSet, _oldState, newState) {
          // Freeze decorations during mouse drag to prevent DOM mutations
          if (_isMouseDragging) {
            return decorationSet;
          }
          if (tr.docChanged) {
            return buildImageSelection(newState);
          }
          if (tr.selectionSet) {
            // Only rebuild if the set of selected images changed
            const { selection } = newState;
            if (selection.empty || selection instanceof NodeSelection) {
              if (lastImagePositions === '') return decorationSet;
              lastImagePositions = '';
              return DecorationSet.empty;
            }

            const { from, to } = selection;
            const positions: number[] = [];
            newState.doc.nodesBetween(from, to, (node, pos) => {
              if (
                node.type.name === 'image' &&
                pos >= from &&
                pos + node.nodeSize <= to
              ) {
                positions.push(pos);
              }
            });
            const newKey = positions.join(',');
            if (newKey === lastImagePositions) return decorationSet;
            return buildImageSelection(newState);
          }
          return decorationSet;
        },
      },
      props: {
        decorations(state) {
          return key.getState(state) ?? DecorationSet.empty;
        },
      },
    });
  }
}
