/**
 * TocExtension
 *
 * Adds [[_TOC_]] (table of contents) block node to the editor.
 * - Atom node that cannot be edited directly
 * - NodeView renders a live list of headings extracted from the document
 * - Clicking a heading entry scrolls to that heading
 * - Auto-updates when document headings change
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView, NodeViewConstructor } from 'prosemirror-view';
import type { NodeSpec, Schema, Node as ProsemirrorNode } from 'prosemirror-model';
import {
  Extension,
  type SerializerNodeHandler,
  type SlashMenuItem,
} from '../../../editor/EditorExtension';
import { getHeadingAnchors, type HeadingAnchor } from '../heading/AnchorPlugin';

// ─── TocExtension ─────────────────────────────────────────────────────────────

export class TocExtension extends Extension {
  get name() {
    return 'toc';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      table_of_contents: {
        group: 'block',
        atom: true,
        selectable: true,
        draggable: true,
        parseDOM: [{ tag: 'div.toc-block' }],
        toDOM() {
          return ['div', { class: 'toc-block', contenteditable: 'false' }, 'Table of Contents'];
        },
      },
    };
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      table_of_contents: (node, view, getPos) =>
        createTocNodeView(node, view, getPos),
    };
  }

  plugins(schema: Schema): Plugin[] {
    return [tocUpdatePlugin()];
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      table_of_contents(state) {
        state.write('[[_TOC_]]');
        state.closeBlock(state.options?.node);
      },
    };
  }

  get slashMenuItems(): SlashMenuItem[] {
    return [
      {
        label: 'Table of Contents',
        keywords: ['toc', 'contents', 'outline', 'navigation'],
        icon: '📑',
        command: (state, dispatch) => {
          if (dispatch) {
            const node = state.schema.nodes.table_of_contents.create();
            dispatch(state.tr.replaceSelectionWith(node));
          }
          return true;
        },
      },
    ];
  }
}

// ─── Plugin: Notify TOC NodeViews to update when headings change ────────────

const tocPluginKey = new PluginKey('tocUpdate');

/** Set of active TocNodeView instances for document-wide heading updates */
const activeTocViews = new Set<{ refresh: (view: EditorView) => void }>();

function tocUpdatePlugin(): Plugin {
  return new Plugin({
    key: tocPluginKey,
    view() {
      return {
        update(view, prevState) {
          if (view.state.doc !== prevState.doc) {
            for (const tocView of activeTocViews) {
              tocView.refresh(view);
            }
          }
        },
      };
    },
  });
}

// ─── NodeView ─────────────────────────────────────────────────────────────────

function createTocNodeView(
  _node: ProsemirrorNode,
  view: EditorView,
  _getPos: (() => number | undefined) | boolean
) {
  const dom = document.createElement('div');
  dom.className = 'toc-block';
  dom.setAttribute('contenteditable', 'false');

  const header = document.createElement('div');
  header.className = 'toc-block-header';

  const headerText = document.createElement('span');
  headerText.textContent = 'Table of Contents';
  header.appendChild(headerText);

  // Delete button (visible on hover)
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'toc-delete-btn';
  deleteBtn.setAttribute('aria-label', 'Delete block');
  deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  deleteBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pos = typeof _getPos === 'function' ? _getPos() : undefined;
    if (pos !== undefined) {
      const currentNode = view.state.doc.nodeAt(pos);
      if (currentNode) {
        const tr = view.state.tr.delete(pos, pos + currentNode.nodeSize);
        view.dispatch(tr);
        view.focus();
      }
    }
  });
  header.appendChild(deleteBtn);

  dom.appendChild(header);

  const list = document.createElement('div');
  list.className = 'toc-block-list';
  dom.appendChild(list);

  function renderHeadings(editorView: EditorView) {
    const anchors = getHeadingAnchors(editorView.state.doc);
    list.innerHTML = '';

    if (anchors.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'toc-block-empty';
      empty.textContent = 'No headings found';
      list.appendChild(empty);
      return;
    }

    // Find minimum level for indentation normalization
    const minLevel = Math.min(...anchors.map(a => a.level));

    for (const anchor of anchors) {
      const item = document.createElement('div');
      item.className = 'toc-block-item';
      item.setAttribute('data-level', String(anchor.level));
      item.style.paddingLeft = `${(anchor.level - minLevel) * 16 + 8}px`;

      const link = document.createElement('a');
      link.className = 'toc-block-link';
      link.textContent = anchor.text || '(empty heading)';
      link.href = `#${anchor.id}`;
      link.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Scroll to heading in editor
        const targetEl = document.getElementById(anchor.id);
        if (targetEl) {
          const headingEl =
            targetEl.closest('h1, h2, h3, h4, h5, h6') ||
            targetEl.nextElementSibling ||
            targetEl.parentElement;
          (headingEl || targetEl).scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });

      item.appendChild(link);
      list.appendChild(item);
    }
  }

  // Initial render
  renderHeadings(view);

  // Register for updates
  const handle = {
    refresh: (v: EditorView) => renderHeadings(v),
  };
  activeTocViews.add(handle);

  return {
    dom,
    update(updatedNode: ProsemirrorNode) {
      return updatedNode.type.name === 'table_of_contents';
    },
    stopEvent() {
      return true; // Prevent ProseMirror from handling events inside TOC
    },
    ignoreMutation() {
      return true; // TOC content is managed by us, not ProseMirror
    },
    destroy() {
      activeTocViews.delete(handle);
    },
  };
}
