/**
 * Code Block Decorations Plugin
 *
 * Adds line numbers and toolbar to code blocks via decorations,
 * avoiding selection issues caused by NodeView.
 * Based on Outline's approach for heading buttons.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { _isMouseDragging } from '../../../editor/EditorCore';
import { getExternalDiagramType, isMermaid, isPlantUml } from '../../../editor/lib/CodeDetection';
import { pluginKey as mermaidPluginKey } from '../mermaid/MermaidPlugin';
import { pluginKey as plantumlPluginKey } from '../plantuml/PlantUmlPlugin';
import { pluginKey as externalDiagramPluginKey } from '../external-diagram/ExternalDiagramPlugin';
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
        const plantumlMeta = tr.getMeta(plantumlPluginKey);
        const externalDiagramMeta = tr.getMeta(externalDiagramPluginKey);
        const mermaidStateChanged = !!mermaidMeta;
        const plantumlStateChanged = !!plantumlMeta;
        const externalDiagramStateChanged = !!externalDiagramMeta;

        // Recreate decorations only on document change or Mermaid state change.
        // Selection changes are handled via CSS :focus-within and the view plugin below.
        if (tr.docChanged || mermaidStateChanged || plantumlStateChanged || externalDiagramStateChanged) {
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

          const basePlantUmlState = plantumlPluginKey.getState(oldState);
          let effectivePlantUmlState = basePlantUmlState;
          if (basePlantUmlState) {
            effectivePlantUmlState = {
              ...basePlantUmlState,
              editingId: plantumlMeta && 'editingId' in plantumlMeta
                ? plantumlMeta.editingId
                : basePlantUmlState.editingId,
              decorationSet: tr.docChanged
                ? basePlantUmlState.decorationSet.map(tr.mapping, tr.doc)
                : basePlantUmlState.decorationSet,
            };
          }

          const baseExternalDiagramState = externalDiagramPluginKey.getState(oldState);
          let effectiveExternalDiagramState = baseExternalDiagramState;
          if (baseExternalDiagramState) {
            effectiveExternalDiagramState = {
              ...baseExternalDiagramState,
              editingId: externalDiagramMeta && 'editingId' in externalDiagramMeta
                ? externalDiagramMeta.editingId
                : baseExternalDiagramState.editingId,
              decorationSet: tr.docChanged
                ? baseExternalDiagramState.decorationSet.map(tr.mapping, tr.doc)
                : baseExternalDiagramState.decorationSet,
            };
          }

          return DecorationSet.create(
            newState.doc,
            createCodeBlockDecorations(
              newState.doc,
              newState,
              editorView,
              effectiveMermaidState,
              effectivePlantUmlState,
              effectiveExternalDiagramState,
            ),
          );
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

function createCodeBlockDecorations(
  doc: ProsemirrorNode,
  state: EditorState,
  view: EditorView | null,
  overrideMermaidState?: any,
  overridePlantUmlState?: any,
  overrideExternalDiagramState?: any,
): Decoration[] {
  const decorations: Decoration[] = [];

  const mermaidState = overrideMermaidState ?? mermaidPluginKey.getState(state);
  const plantumlState = overridePlantUmlState ?? plantumlPluginKey.getState(state);
  const externalDiagramState = overrideExternalDiagramState ?? externalDiagramPluginKey.getState(state);

  doc.descendants((node, pos) => {
    if (node.type.name === 'code_block') {
      // Note: 'has-cursor' class is managed by the view plugin (lightweight DOM toggle)
      // instead of decoration rebuild, to avoid massive DOM churn on selection changes.

      // Check if this is a Mermaid diagram
      const isMermaidDiagram = isMermaid(node);
      const isPlantUmlDiagram = isPlantUml(node);
      const externalDiagramType = getExternalDiagramType(node);

      let diagram: { kind: 'mermaid' | 'plantuml' | 'externalDiagram'; isEditing: boolean; diagramId?: string } | null = null;
      if (isMermaidDiagram && mermaidState) {
        const diagramDecorations = mermaidState.decorationSet.find(pos, pos + node.nodeSize);
        const diagramId = diagramDecorations.find((d: any) => d.spec?.diagramId && d.from === pos)?.spec?.diagramId;
        diagram = {
          kind: 'mermaid',
          diagramId,
          isEditing: !!(diagramId && mermaidState.editingId === diagramId),
        };
      } else if (isPlantUmlDiagram && plantumlState) {
        const diagramDecorations = plantumlState.decorationSet.find(pos, pos + node.nodeSize);
        const diagramId = diagramDecorations.find((d: any) => d.spec?.diagramId && d.from === pos)?.spec?.diagramId;
        diagram = {
          kind: 'plantuml',
          diagramId,
          isEditing: !!(diagramId && plantumlState.editingId === diagramId),
        };
      } else if (externalDiagramType && externalDiagramState) {
        const diagramDecorations = externalDiagramState.decorationSet.find(pos, pos + node.nodeSize);
        const diagramId = diagramDecorations.find((d: any) => d.spec?.diagramId && d.from === pos)?.spec?.diagramId;
        diagram = {
          kind: 'externalDiagram',
          diagramId,
          isEditing: !!(diagramId && externalDiagramState.editingId === diagramId),
        };
      }

      // Add line numbers decoration
      decorations.push(...createLineNumbersDecorations(node, pos, diagram));

      // Add toolbar decoration
      if (diagram) {
        if (diagram.isEditing) {
          decorations.push(createToolbarDecoration(node, pos + 1, pos, view, diagram));
        } else {
          decorations.push(createMermaidContainerDecoration(node, pos, view, diagram));
        }
      } else {
        decorations.push(createToolbarDecoration(node, pos + 1, pos, view, null));
      }
    }
  });

  return decorations;
}
