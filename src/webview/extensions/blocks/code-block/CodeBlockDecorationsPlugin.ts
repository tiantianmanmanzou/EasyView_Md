/**
 * Code Block Decorations Plugin
 *
 * Adds line numbers and toolbar to code blocks via decorations,
 * avoiding selection issues caused by NodeView.
 * Based on Outline's approach for heading buttons.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { _isMouseDragging } from '../../../editor/EditorCore';
import { pluginKey as mermaidPluginKey } from '../mermaid/MermaidPlugin';
import { createLineNumbersDecorations, createToolbarDecoration, createMermaidContainerDecoration } from './CodeBlockToolbar';

export const codeBlockDecorationsKey = new PluginKey('codeBlockDecorations');

export function codeBlockDecorationsPlugin() {
  let editorView: EditorView | null = null;

  return new Plugin({
    key: codeBlockDecorationsKey,
    view(view) {
      editorView = view;
      let lastCursorCodeBlock: HTMLElement | null = null;

      return {
        update(view) {
          // Skip DOM mutations during mouse drag to preserve native selection
          if (_isMouseDragging) return;

          // Lightweight cursor tracking: toggle 'has-cursor' class via DOM
          // instead of rebuilding all decorations on selection change
          const { from, to } = view.state.selection;
          let cursorCodeBlock: HTMLElement | null = null;
          const $from = view.state.doc.resolve(from);
          for (let d = $from.depth; d > 0; d--) {
            if ($from.node(d).type.name === 'code_block') {
              const pos = $from.before(d);
              const domNode = view.nodeDOM(pos);
              if (domNode instanceof HTMLElement) {
                // Also check selection end is within the same code block
                const nodeEnd = pos + $from.node(d).nodeSize;
                if (to <= nodeEnd) {
                  cursorCodeBlock = domNode;
                }
              }
              break;
            }
          }
          if (cursorCodeBlock !== lastCursorCodeBlock) {
            // Wrap in domObserver.stop()/start() to hide class mutations from
            // ProseMirror's MutationObserver.  Without this, the observer sees
            // the attribute change, marks the code_block dirty, re-renders it
            // (creating a NEW <pre> element), which causes updatePluginViews()
            // to add has-cursor again -> infinite loop -> editor freeze.
            const obs = (view as any).domObserver;
            obs?.stop();
            lastCursorCodeBlock?.classList.remove('has-cursor');
            cursorCodeBlock?.classList.add('has-cursor');
            obs?.start();
            lastCursorCodeBlock = cursorCodeBlock;
          }
        },
        destroy() {
          editorView = null;
          lastCursorCodeBlock?.classList.remove('has-cursor');
        }
      };
    },
    state: {
      init: (_, state) => {
        return DecorationSet.create(state.doc, createCodeBlockDecorations(state.doc, state, editorView));
      },
      apply: (tr, decorationSet, oldState, newState) => {
        // Check if Mermaid state changed (editingId or loaded)
        const mermaidMeta = tr.getMeta(mermaidPluginKey);
        const mermaidStateChanged = !!mermaidMeta;

        // Recreate decorations only on document change or Mermaid state change.
        // Selection changes are handled via CSS :focus-within and the view plugin below.
        if (tr.docChanged || mermaidStateChanged) {
          // Build effective mermaid state: use oldState (always available) + apply meta changes.
          // We can't use mermaidPluginKey.getState(newState) because the mermaid plugin
          // may not have processed this transaction yet (plugin ordering).
          const baseMermaidState = mermaidPluginKey.getState(oldState);
          let effectiveMermaidState = baseMermaidState;
          if (baseMermaidState) {
            effectiveMermaidState = {
              ...baseMermaidState,
              editingId: mermaidMeta && 'editingId' in mermaidMeta
                ? mermaidMeta.editingId
                : baseMermaidState.editingId,
              decorationSet: tr.docChanged
                ? baseMermaidState.decorationSet.map(tr.mapping, tr.doc)
                : baseMermaidState.decorationSet,
            };
          }
          return DecorationSet.create(newState.doc, createCodeBlockDecorations(newState.doc, newState, editorView, effectiveMermaidState));
        }
        // Map existing decorations if no doc change
        return decorationSet.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return codeBlockDecorationsKey.getState(state);
      },
    },
  });
}

function createCodeBlockDecorations(doc: ProsemirrorNode, state: EditorState, view: EditorView | null, overrideMermaidState?: any): Decoration[] {
  const decorations: Decoration[] = [];

  // Get Mermaid plugin state to check editingId
  // Use override if provided (from apply, where newState may not have mermaid state yet)
  const mermaidState = overrideMermaidState ?? mermaidPluginKey.getState(state);

  doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') {
      // Note: 'has-cursor' class is managed by the view plugin (lightweight DOM toggle)
      // instead of decoration rebuild, to avoid massive DOM churn on selection changes.

      // Check if this is a Mermaid diagram
      const language = node.attrs.language || '';
      const isMermaid = language === 'mermaid' || language === 'mermaidjs';

      // Add line numbers decoration
      decorations.push(...createLineNumbersDecorations(node, pos, isMermaid, mermaidState));

      // Add toolbar decoration
      if (isMermaid) {
        // Check if in editing mode
        let diagramId: string | undefined;
        if (mermaidState) {
          const decorations = mermaidState.decorationSet.find(pos, pos + node.nodeSize);
          if (decorations && decorations.length > 0) {
            for (const dec of decorations) {
              if (dec.spec && dec.spec.diagramId) {
                diagramId = dec.spec.diagramId;
                break;
              }
            }
          }
        }
        const isEditing = diagramId && mermaidState?.editingId === diagramId;

        if (isEditing) {
          // Editing mode: normal toolbar inside code block (with Edit button)
          decorations.push(createToolbarDecoration(node, pos + 1, pos, view, isMermaid, mermaidState));
        } else {
          // Preview mode: toolbar over diagram
          decorations.push(createMermaidContainerDecoration(node, pos, view, mermaidState));
        }
      } else {
        // For normal code: create toolbar inside code block
        decorations.push(createToolbarDecoration(node, pos + 1, pos, view, isMermaid, mermaidState));
      }
    }
  });

  return decorations;
}
