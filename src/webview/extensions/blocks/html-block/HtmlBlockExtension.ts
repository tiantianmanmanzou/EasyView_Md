/**
 * HtmlBlockExtension
 *
 * Handles html_block and html_inline nodes.
 * Renders raw HTML with a label, serializes back to raw HTML.
 * HTML comments (<!-- ... -->) get a compact icon with hover tooltip.
 */

import type { NodeViewConstructor, EditorView } from 'prosemirror-view';
import type { NodeSpec, Node as ProsemirrorNode, Schema } from 'prosemirror-model';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import {
  Extension,
  type SlashMenuItem,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';
import { schema } from '../../../editor/EditorSchema';

/** Regex to detect HTML comment blocks */
const COMMENT_RE = /^\s*<!--([\s\S]*?)-->\s*$/;

/** Extract comment text from HTML content, or null if not a comment */
function extractComment(html: string): string | null {
  const match = html.match(COMMENT_RE);
  return match ? match[1].trim() : null;
}

/** Flag set by slash menu to auto-start editing on newly created comments */
export let autoEditNextComment = false;

/** Called from slash menu to trigger auto-edit on next comment NodeView creation */
export function scheduleAutoEditComment() {
  autoEditNextComment = true;
}

export class HtmlBlockExtension extends Extension {
  get name() {
    return 'htmlBlock';
  }

  get nodes(): Record<string, NodeSpec> {
    return {
      html_block: {
        attrs: { html: { default: '' } },
        group: 'block',
        atom: true,
        selectable: true,
        defining: true,
        isolating: true,
        parseDOM: [
          {
            tag: 'div[data-type="html_block"]',
            getAttrs(dom: HTMLDivElement) {
              return { html: dom.getAttribute('data-html') || dom.textContent || '' };
            },
          },
        ],
        toDOM(node) {
          return [
            'div',
            {
              'data-type': 'html_block',
              'data-html': node.attrs.html,
              class: 'html-block',
              contenteditable: 'false',
            },
            ['div', { class: 'html-block-label' }, 'HTML'],
            ['pre', { class: 'html-block-code' }, node.attrs.html],
          ];
        },
      },
      html_inline: {
        attrs: { html: { default: '' } },
        inline: true,
        group: 'inline',
        atom: true,
        parseDOM: [
          {
            tag: 'span[data-type="html_inline"]',
            getAttrs(dom: HTMLElement) {
              return { html: dom.getAttribute('data-html') || '' };
            },
          },
        ],
        toDOM(node) {
          return [
            'span',
            { 'data-type': 'html_inline', 'data-html': node.attrs.html, class: 'html-inline' },
            node.attrs.html,
          ];
        },
      },
    };
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      html_block: (node, view, getPos) => createHtmlBlockNodeView(node, view, getPos),
    };
  }

  get serializerNodes(): Record<string, SerializerNodeHandler> {
    return {
      html_block(state, node) {
        state.text(node.attrs.html, false);
        state.closeBlock(node);
      },
      html_inline(state, node) {
        state.text(node.attrs.html, false);
      },
    };
  }

  get slashMenuItems(): SlashMenuItem[] {
    return [
      {
        label: 'Comment',
        keywords: ['comment', 'hidden', 'html', 'note', 'комментарий'],
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        action: (view: EditorView) => {
          const { $from } = view.state.selection;
          const from = $from.before($from.depth);
          const to = $from.after($from.depth);
          const commentNode = schema.nodes.html_block.create({ html: '<!-- Comment -->' });
          const tr = view.state.tr.replaceWith(from, to, [
            commentNode,
            schema.nodes.paragraph.create(),
          ]);
          // Select the comment node so NodeView auto-enters edit mode
          tr.setSelection(NodeSelection.create(tr.doc, from));
          autoEditNextComment = true;
          view.dispatch(tr.scrollIntoView());
          view.focus();
        },
      },
    ];
  }
}

// ─── Comment Icon SVG ────────────────────────────────────────────────────────

const COMMENT_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
</svg>`;

// ─── NodeView ───────────────────────────────────────────────────────────────

function createHtmlBlockNodeView(node: ProsemirrorNode, view: EditorView, getPos: () => number | undefined) {
  const html = node.attrs.html || '';
  const commentText = extractComment(html);

  if (commentText !== null) {
    return createCommentNodeView(node, commentText, view, getPos);
  }

  return createStandardHtmlNodeView(node, view, getPos);
}

/** Standard HTML block: rendered HTML in a scoped container + edit button */
function createStandardHtmlNodeView(node: ProsemirrorNode, view: EditorView, getPos: () => number | undefined) {
  const dom = document.createElement('div');
  dom.className = 'html-block';
  dom.setAttribute('contenteditable', 'false');
  dom.setAttribute('data-html', node.attrs.html);

  // Rendered HTML in a scoped container (style containment)
  const rendered = document.createElement('div');
  rendered.className = 'html-block-rendered';
  rendered.innerHTML = node.attrs.html;
  dom.appendChild(rendered);

  // Label
  const label = document.createElement('div');
  label.className = 'html-block-label';
  label.textContent = 'HTML';
  dom.appendChild(label);

  // Edit button
  const editBtn = document.createElement('button');
  editBtn.className = 'html-block-edit-btn';
  editBtn.textContent = 'Edit';
  editBtn.title = 'Edit HTML source';
  dom.appendChild(editBtn);

  // Editing state
  let isEditing = false;
  let editorContainer: HTMLDivElement | null = null;
  let editorTextarea: HTMLTextAreaElement | null = null;

  function startEditing() {
    if (isEditing) return;
    isEditing = true;
    dom.classList.add('html-block-editing');
    rendered.style.display = 'none';

    editorContainer = document.createElement('div');
    editorContainer.className = 'html-block-editor-container';

    editorTextarea = document.createElement('textarea');
    editorTextarea.className = 'html-block-editor-textarea';
    editorTextarea.value = dom.getAttribute('data-html') || '';
    editorTextarea.spellcheck = false;

    const btnBar = document.createElement('div');
    btnBar.className = 'html-block-editor-btnbar';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'html-block-editor-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', (e) => { e.stopPropagation(); finishEditing(); });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'html-block-editor-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancelEditing(); });

    btnBar.appendChild(saveBtn);
    btnBar.appendChild(cancelBtn);
    editorContainer.appendChild(editorTextarea);
    editorContainer.appendChild(btnBar);
    dom.insertBefore(editorContainer, label);

    editorTextarea.focus();

    // Auto-resize
    const autoResize = () => {
      if (!editorTextarea) return;
      editorTextarea.style.height = 'auto';
      editorTextarea.style.height = editorTextarea.scrollHeight + 'px';
    };
    editorTextarea.addEventListener('input', autoResize);
    requestAnimationFrame(autoResize);

    editorTextarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancelEditing(); }
      if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishEditing(); }
    });
  }

  function finishEditing() {
    if (!isEditing || !editorTextarea) return;
    const newHtml = editorTextarea.value;
    const pos = getPos();
    cleanupEditing();
    if (pos !== undefined) {
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, { html: newHtml })
      );
    }
    view.focus();
  }

  function cancelEditing() {
    cleanupEditing();
    view.focus();
  }

  function cleanupEditing() {
    isEditing = false;
    dom.classList.remove('html-block-editing');
    rendered.style.display = '';
    if (editorContainer) { editorContainer.remove(); editorContainer = null; }
    editorTextarea = null;
  }

  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    startEditing();
  });

  // Double-click to edit
  dom.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startEditing();
  });

  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: (event: Event) => {
      if (isEditing && editorTextarea) {
        const target = event.target as HTMLElement;
        if (editorContainer?.contains(target)) return true;
      }
      // Allow interactive elements in rendered HTML to work
      const target = event.target as HTMLElement;
      if (target.closest('.html-block-rendered') && (
        target.tagName === 'DETAILS' || target.tagName === 'SUMMARY' ||
        target.tagName === 'A' || target.closest('details')
      )) {
        return true;
      }
      return false;
    },
    update(updatedNode: ProsemirrorNode) {
      if (updatedNode.type.name !== 'html_block') return false;
      const newComment = extractComment(updatedNode.attrs.html);
      if (newComment !== null) return false; // Let ProseMirror recreate as comment view
      dom.setAttribute('data-html', updatedNode.attrs.html);
      if (!isEditing) {
        rendered.innerHTML = updatedNode.attrs.html;
      }
      return true;
    },
  };
}

/** Comment block: compact icon with hover tooltip + double-click to edit */
function createCommentNodeView(node: ProsemirrorNode, commentText: string, view: EditorView, getPos: () => number | undefined) {
  const dom = document.createElement('div');
  dom.className = 'html-block html-comment';
  dom.setAttribute('contenteditable', 'false');
  dom.setAttribute('data-html', node.attrs.html);

  // Icon
  const icon = document.createElement('span');
  icon.className = 'html-comment-icon';
  icon.innerHTML = COMMENT_ICON;
  dom.appendChild(icon);

  // Label (shown when not editing)
  const label = document.createElement('span');
  label.className = 'html-comment-label';
  label.textContent = commentText.length > 60
    ? commentText.slice(0, 57) + '...'
    : commentText;
  dom.appendChild(label);

  // Tooltip for full text (shown on hover, hidden during editing)
  const tooltip = document.createElement('div');
  tooltip.className = 'html-comment-tooltip';
  tooltip.textContent = commentText;
  dom.appendChild(tooltip);

  // ── Editing state ──
  let isEditing = false;
  let textarea: HTMLTextAreaElement | null = null;

  function startEditing() {
    if (isEditing) return;
    isEditing = true;
    dom.classList.add('html-comment-editing');

    // Hide display elements
    label.style.display = 'none';

    // Create textarea
    textarea = document.createElement('textarea');
    textarea.className = 'html-comment-editor';
    const currentText = extractComment(dom.getAttribute('data-html') || '') || '';
    textarea.value = currentText === 'Comment' ? '' : currentText;
    textarea.placeholder = 'Comment text...';
    textarea.rows = 1;
    dom.insertBefore(textarea, tooltip);

    // Auto-resize
    const autoResize = () => {
      if (!textarea) return;
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    };
    textarea.addEventListener('input', autoResize);

    textarea.focus();
    if (currentText !== 'Comment') textarea.select();
    requestAnimationFrame(autoResize);

    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finishEditing();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEditing();
      }
    });

    textarea.addEventListener('blur', () => {
      // Small delay to avoid conflicts with other click handlers
      setTimeout(() => {
        if (isEditing) finishEditing();
      }, 100);
    });
  }

  function finishEditing() {
    if (!isEditing || !textarea) return;
    const newText = textarea.value.trim() || 'Comment';
    const pos = getPos();
    // Cleanup BEFORE dispatch so update() sees isEditing=false and updates label
    cleanupEditing();
    if (pos !== undefined) {
      const newHtml = `<!-- ${newText} -->`;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, { html: newHtml })
      );
    }
    view.focus();
  }

  function cancelEditing() {
    cleanupEditing();
    view.focus();
  }

  function cleanupEditing() {
    isEditing = false;
    dom.classList.remove('html-comment-editing');
    if (textarea) {
      textarea.remove();
      textarea = null;
    }
    label.style.display = '';
  }

  // Double-click to edit
  dom.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    startEditing();
  });

  // Auto-start editing for newly inserted comments from slash menu
  if (autoEditNextComment) {
    autoEditNextComment = false;
    // Delay to let slash menu fully close before focusing textarea
    setTimeout(() => startEditing(), 50);
  }

  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: (event: Event) => {
      // When editing, capture events targeted at the textarea
      if (isEditing && textarea) {
        const target = event.target as HTMLElement;
        if (target === textarea || textarea.contains(target)) {
          return true;
        }
      }
      return false;
    },
    update(updatedNode: ProsemirrorNode) {
      if (updatedNode.type.name !== 'html_block') return false;
      const newComment = extractComment(updatedNode.attrs.html);
      if (newComment === null) return false; // Let ProseMirror recreate as standard view
      dom.setAttribute('data-html', updatedNode.attrs.html);
      if (!isEditing) {
        label.textContent = newComment.length > 60
          ? newComment.slice(0, 57) + '...'
          : newComment;
        tooltip.textContent = newComment;
      }
      return true;
    },
  };
}
