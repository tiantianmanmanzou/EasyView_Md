/**
 * DetailsExtension
 *
 * Handles <details>/<summary> blocks with:
 * - Collapsible content
 * - Inline summary editing
 * - Gap zones before/after for paragraph insertion
 */

import type {
  NodeViewConstructor,
  EditorView,
} from 'prosemirror-view';
import type { NodeSpec, Schema, Node as ProsemirrorNode } from 'prosemirror-model';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

export class DetailsExtension extends Extension {
  get name() {
    return 'details';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      details: {
        attrs: { summary: { default: 'Details' } },
        content: 'block+',
        group: 'block',
        defining: true,
        isolating: true,
        parseDOM: [
          {
            tag: 'details',
            getAttrs(dom: HTMLDetailsElement) {
              const summaryEl = dom.querySelector('summary');
              return { summary: summaryEl?.textContent || 'Details' };
            },
          },
          {
            tag: 'div.details-block',
            getAttrs(dom: HTMLDivElement) {
              const summaryEl = dom.querySelector('.details-summary-text');
              return { summary: summaryEl?.textContent || 'Details' };
            },
          },
        ],
        toDOM(node) {
          return [
            'div',
            { class: 'details-block details-collapsed' },
            ['div', { class: 'details-summary', contenteditable: 'false' },
              ['span', { class: 'details-arrow' }],
              ['span', { class: 'details-summary-text' }, node.attrs.summary],
            ],
            ['div', { class: 'details-content' }, 0],
          ];
        },
      },
    };
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      details: (node, view, getPos) =>
        createDetailsNodeView(node, view, getPos),
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      details(state, node) {
        const summary = (node.attrs.summary || 'Details')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        state.write(`<details>\n<summary>${summary}</summary>\n\n`);
        state.renderContent(node);
        state.write('</details>');
        state.closeBlock(node);
      },
    };
  }
}

// ─── NodeView ───────────────────────────────────────────────────────────────

function createDetailsNodeView(
  node: ProsemirrorNode,
  view: EditorView,
  getPos: (() => number | undefined) | boolean
) {
  // Details block
  const dom = document.createElement('div');
  dom.className = 'details-block details-collapsed';

  const summaryRow = document.createElement('div');
  summaryRow.className = 'details-summary';
  summaryRow.setAttribute('contenteditable', 'false');

  const arrow = document.createElement('span');
  arrow.className = 'details-arrow';

  const summaryText = document.createElement('span');
  summaryText.className = 'details-summary-text';
  summaryText.textContent = node.attrs.summary;

  let editingInput: HTMLInputElement | null = null;

  arrow.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dom.classList.toggle('details-collapsed');
  });

  summaryText.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (editingInput) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'details-summary-input';
    input.value = summaryText.textContent || '';
    editingInput = input;

    const save = () => {
      if (!input.parentNode) return;
      const newText = input.value.trim() || 'Details';
      summaryText.textContent = newText;
      summaryText.style.display = '';
      input.remove();
      editingInput = null;

      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (pos !== undefined) {
        const currentNode = view.state.doc.nodeAt(pos);
        if (currentNode && currentNode.attrs.summary !== newText) {
          const tr = view.state.tr.setNodeMarkup(pos, undefined, {
            ...currentNode.attrs,
            summary: newText,
          });
          view.dispatch(tr);
        }
      }
      view.focus();
    };

    input.addEventListener('keydown', (ke) => {
      ke.stopPropagation();
      if (ke.key === 'Enter') {
        ke.preventDefault();
        save();
      }
      if (ke.key === 'Escape') {
        ke.preventDefault();
        summaryText.style.display = '';
        input.remove();
        editingInput = null;
        view.focus();
      }
    });
    input.addEventListener('blur', save);

    summaryText.style.display = 'none';
    summaryRow.appendChild(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });

  // Delete button (visible on hover)
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'details-delete-btn';
  deleteBtn.setAttribute('aria-label', 'Delete block');
  deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
  deleteBtn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos !== undefined) {
      const currentNode = view.state.doc.nodeAt(pos);
      if (currentNode) {
        const tr = view.state.tr.delete(pos, pos + currentNode.nodeSize);
        view.dispatch(tr);
        view.focus();
      }
    }
  });

  summaryRow.appendChild(arrow);
  summaryRow.appendChild(summaryText);
  summaryRow.appendChild(deleteBtn);
  dom.appendChild(summaryRow);

  const contentDOM = document.createElement('div');
  contentDOM.className = 'details-content';
  dom.appendChild(contentDOM);

  return {
    dom,
    contentDOM,
    update(updatedNode: ProsemirrorNode) {
      if (updatedNode.type.name !== 'details') return false;
      if (summaryText.textContent !== updatedNode.attrs.summary) {
        summaryText.textContent = updatedNode.attrs.summary;
      }
      return true;
    },
    stopEvent(e: Event) {
      const target = e.target as Node;
      if (summaryRow.contains(target)) return true;
      return false;
    },
    ignoreMutation(mutation: MutationRecord) {
      return !contentDOM.contains(mutation.target);
    },
  };
}
