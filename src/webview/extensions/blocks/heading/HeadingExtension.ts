/**
 * HeadingExtension
 *
 * Handles heading nodes: fold/unfold, anchor links, widget decorations.
 * Schema node, input rules, keymaps, plugins, and serializer.
 */

import {
  Plugin,
  PluginKey,
  type EditorState,
} from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  type EditorView,
} from 'prosemirror-view';
import { textblockTypeInputRule, type InputRule } from 'prosemirror-inputrules';
import type { NodeSpec, Schema, Node as ProsemirrorNode } from 'prosemirror-model';
import type { Command } from 'prosemirror-commands';
import { setBlockType } from 'prosemirror-commands';
import { findCollapsedNodes } from './FindCollapsedNodes';
import { getHeadingAnchors, anchorPlugin } from './AnchorPlugin';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

// ─── Toast helper (imported lazily to avoid circular deps) ──────────────────

let showToastFn: ((msg: string) => void) | null = null;

/** Register a toast function from the UI layer */
export function setToastFunction(fn: (msg: string) => void) {
  showToastFn = fn;
}

function showToast(msg: string) {
  if (showToastFn) showToastFn(msg);
}

// ─── Heading Extension ──────────────────────────────────────────────────────

export class HeadingExtension extends Extension {
  get name() {
    return 'heading';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      heading: {
        attrs: {
          level: { default: 1, validate: 'number' },
          collapsed: { default: undefined },
        },
        content: 'inline*',
        group: 'block',
        defining: true,
        parseDOM: [
          { tag: 'h1', attrs: { level: 1 } },
          { tag: 'h2', attrs: { level: 2 } },
          { tag: 'h3', attrs: { level: 3 } },
          { tag: 'h4', attrs: { level: 4 } },
          { tag: 'h5', attrs: { level: 5 } },
          { tag: 'h6', attrs: { level: 6 } },
        ],
        toDOM(node) {
          return [
            `h${node.attrs.level}`,
            { class: 'heading-content', dir: 'auto' },
            0,
          ];
        },
      },
    };
  }

  inputRules(schema: Schema): InputRule[] {
    const rules: InputRule[] = [];
    for (let level = 1; level <= 6; level++) {
      rules.push(
        textblockTypeInputRule(
          new RegExp(`^(#{${level}})\\s$`),
          schema.nodes.heading,
          () => ({ level })
        )
      );
    }
    return rules;
  }

  keymaps(schema: Schema): Record<string, Command> {
    return {
      'Shift-Ctrl-0': setBlockType(schema.nodes.paragraph),
      'Shift-Ctrl-1': setBlockType(schema.nodes.heading, { level: 1 }),
      'Shift-Ctrl-2': setBlockType(schema.nodes.heading, { level: 2 }),
      'Shift-Ctrl-3': setBlockType(schema.nodes.heading, { level: 3 }),
      'Shift-Ctrl-4': setBlockType(schema.nodes.heading, { level: 4 }),
    };
  }

  plugins(_schema: Schema): Plugin[] {
    return [...this.headingPlugin(), anchorPlugin()];
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      heading(state, node) {
        state.write('#'.repeat(node.attrs.level) + ' ');
        state.renderInline(node);
        state.closeBlock(node);
      },
    };
  }

  // ── Private: Heading Plugin ──

  private headingPlugin(): Plugin[] {
    const widgetsPlugin = new Plugin({
      key: new PluginKey('headingWidgets'),
      state: {
        init(_, { doc }) {
          return DecorationSet.create(doc, createHeadingWidgets(doc));
        },
        apply(tr, oldDecoSet) {
          if (tr.docChanged) {
            return DecorationSet.create(tr.doc, createHeadingWidgets(tr.doc));
          }
          return oldDecoSet.map(tr.mapping, tr.doc);
        },
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    });

    const foldPlugin = new Plugin({
      key: new PluginKey('headingFold'),
      state: {
        init(_, { doc }) {
          const decorations: Decoration[] = findCollapsedNodes(doc).map((block) =>
            Decoration.node(block.pos, block.pos + block.node.nodeSize, {
              class: 'folded-content',
            })
          );
          return DecorationSet.create(doc, decorations);
        },
        apply(tr, oldDecoSet) {
          if (tr.docChanged) {
            const decorations: Decoration[] = findCollapsedNodes(tr.doc).map(
              (block) =>
                Decoration.node(block.pos, block.pos + block.node.nodeSize, {
                  class: 'folded-content',
                })
            );
            return DecorationSet.create(tr.doc, decorations);
          }
          return oldDecoSet.map(tr.mapping, tr.doc);
        },
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    });

    return [widgetsPlugin, foldPlugin];
  }
}

// ─── Fold functions (exported for FileHeader/external use) ──────────────────

export function toggleHeadingFold(view: EditorView, headingPos: number): void {
  const node = view.state.doc.nodeAt(headingPos);
  if (!node || node.type.name !== 'heading') return;

  const collapsed = !node.attrs.collapsed;

  let headingScreenY: number | null = null;
  try {
    const domPos = view.domAtPos(headingPos + 1);
    const el =
      domPos.node instanceof HTMLElement
        ? domPos.node
        : domPos.node.parentElement;
    if (el) {
      headingScreenY = el.getBoundingClientRect().top;
    }
  } catch {
    /* ok */
  }

  const tr = view.state.tr.setNodeMarkup(headingPos, undefined, {
    ...node.attrs,
    collapsed,
  });

  view.dispatch(tr);

  if (headingScreenY !== null) {
    requestAnimationFrame(() => {
      try {
        const domPos = view.domAtPos(headingPos + 1);
        const el =
          domPos.node instanceof HTMLElement
            ? domPos.node
            : domPos.node.parentElement;
        if (el) {
          const newY = el.getBoundingClientRect().top;
          const delta = newY - headingScreenY!;
          if (Math.abs(delta) > 1) {
            const scrollArea = document.getElementById('editor-scroll-area');
            if (scrollArea) {
              scrollArea.scrollTop += delta;
            }
          }
        }
      } catch {
        /* ok */
      }
    });
  }
}

export function toggleAllHeadings(
  view: EditorView,
  collapse: boolean
): void {
  const { doc } = view.state;
  const tr = view.state.tr;

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        collapsed: collapse,
      });
    }
  });

  if (tr.docChanged) {
    view.dispatch(tr);
  }
}

// ─── Widget creation ────────────────────────────────────────────────────────

function createHeadingWidgets(doc: ProsemirrorNode): Decoration[] {
  const decorations: Decoration[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      const $pos = doc.resolve(pos);
      if ($pos.depth > 1) return;
      if (node.content.size === 0) return;

      const collapsed = node.attrs.collapsed;
      const headingPos = pos;

      decorations.push(
        Decoration.widget(
          pos + 1,
          (view) => {
            const anchor = document.createElement('button');
            anchor.innerText = '#';
            anchor.type = 'button';
            anchor.className = 'heading-anchor';
            anchor.tabIndex = -1;
            anchor.addEventListener('mousedown', (event) => {
              event.preventDefault();
              if (event.button !== 0) return;
              const anchors = getHeadingAnchors(view.state.doc);
              const found = anchors.find((a) => a.pos === headingPos);
              if (found) {
                const md = `[${node.textContent}](#${found.id})`;
                navigator.clipboard.writeText(md).then(
                  () => showToast('Link copied'),
                  () => {}
                );
              }
            });

            const fold = document.createElement('button');
            fold.innerHTML =
              '<svg fill="currentColor" width="16" height="28" viewBox="4 0 16 24" xmlns="http://www.w3.org/2000/svg"><path d="M8.23823905,10.6097108 L11.207376,14.4695888 L11.207376,14.4695888 C11.54411,14.907343 12.1719566,14.989236 12.6097108,14.652502 C12.6783439,14.5997073 12.7398293,14.538222 12.792624,14.4695888 L15.761761,10.6097108 L15.761761,10.6097108 C16.0984949,10.1719566 16.0166019,9.54410997 15.5788477,9.20737601 C15.4040391,9.07290785 15.1896811,9 14.969137,9 L9.03086304,9 L9.03086304,9 C8.47857829,9 8.03086304,9.44771525 8.03086304,10 C8.03086304,10.2205442 8.10377089,10.4349022 8.23823905,10.6097108 Z" /></svg>';
            fold.type = 'button';
            fold.className = `heading-fold${collapsed ? ' collapsed' : ''}`;
            fold.tabIndex = -1;
            fold.addEventListener('mousedown', (event) => {
              event.preventDefault();
              if (event.button !== 0) return;
              toggleHeadingFold(view, headingPos);
            });

            const container = document.createElement('span');
            container.contentEditable = 'false';
            container.className = `heading-actions${collapsed ? ' collapsed' : ''}`;
            container.appendChild(anchor);
            container.appendChild(fold);

            return container;
          },
          {
            side: -1,
            ignoreSelection: true,
            key: `heading-${pos}-${collapsed ? 'collapsed' : 'expanded'}`,
          }
        )
      );
    }
  });

  return decorations;
}
