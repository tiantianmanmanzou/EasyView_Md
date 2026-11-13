/**
 * EditorCaretExtension
 *
 * Draws the text caret as a 2px bar in the editor cursor color, matching the
 * VS Code / Cursor text editor. The caret stays solid while it moves and starts
 * blinking once it rests. The native caret is hidden only while this overlay is
 * shown; IME composition, node selections, block-edge cursors and the caret
 * next to inline atoms keep their own rendering.
 */

import { Plugin, TextSelection } from 'prosemirror-state';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { Extension } from '../../../editor/EditorExtension';
import { _isMouseDragging } from '../../../editor/EditorCore';

const CARET_WIDTH = 2;
const ACTIVE_CLASS = 'editor-caret-active';

export class EditorCaretExtension extends Extension {
  get name() {
    return 'editorCaret';
  }

  plugins(): Plugin[] {
    return [new Plugin({ view: (view) => new EditorCaretView(view) })];
  }
}

/** Inline atoms such as images; text nodes are leaves too (`isAtom` is true for them), so exclude them. */
function isInlineAtom(node: ProseMirrorNode | null | undefined): boolean {
  return !!node && node.isInline && node.isAtom && !node.isText;
}

function caretPosition(view: EditorView): number | null {
  const { selection } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return null;
  const { nodeBefore, nodeAfter } = selection.$head;
  if (isInlineAtom(nodeBefore) || isInlineAtom(nodeAfter)) return null;
  return selection.head;
}

type CaretCoords = { left: number; top: number; bottom: number };

/**
 * Screen coordinates of the caret at `pos`. ProseMirror has already synced the
 * DOM selection when plugin views update, so its collapsed range sits exactly
 * where the native caret would be. `coordsAtPos` is only a fallback: next to
 * decoration widgets inside a paragraph it measures the widget and can return
 * a zero-height rect. Returns null when nothing measurable exists.
 */
function caretCoords(view: EditorView, pos: number): CaretCoords | null {
  const selection = (view.root as Document).getSelection?.() ?? document.getSelection();
  if (selection && selection.rangeCount > 0 && selection.isCollapsed && selection.focusNode && view.dom.contains(selection.focusNode)) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.height > 0) return { left: rect.left, top: rect.top, bottom: rect.bottom };
  }
  try {
    const coords = view.coordsAtPos(pos);
    return coords.bottom > coords.top ? coords : null;
  } catch {
    return null;
  }
}

class EditorCaretView {
  private readonly container: HTMLElement;
  private element: HTMLElement | null = null;
  private lastKey = '';
  private readonly resizeObserver: ResizeObserver;

  constructor(private view: EditorView) {
    this.container = view.dom.parentElement || view.dom;
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }
    view.dom.addEventListener('focus', this.refresh);
    view.dom.addEventListener('blur', this.refresh);
    view.dom.addEventListener('compositionstart', this.refresh);
    view.dom.addEventListener('compositionend', this.refresh);
    document.addEventListener('mouseup', this.refresh, true);
    document.addEventListener('scroll', this.reposition, true);
    this.resizeObserver = new ResizeObserver(this.reposition);
    this.resizeObserver.observe(view.dom);
    this.render(true);
  }

  update(view: EditorView) {
    this.view = view;
    if (_isMouseDragging) return;
    this.render(true);
  }

  destroy() {
    const { dom } = this.view;
    dom.removeEventListener('focus', this.refresh);
    dom.removeEventListener('blur', this.refresh);
    dom.removeEventListener('compositionstart', this.refresh);
    dom.removeEventListener('compositionend', this.refresh);
    document.removeEventListener('mouseup', this.refresh, true);
    document.removeEventListener('scroll', this.reposition, true);
    this.resizeObserver.disconnect();
    this.hide();
  }

  private readonly refresh = () => {
    // Composition events fire before ProseMirror updates `view.composing`, and
    // the selection placed by a click settles only after mouseup.
    requestAnimationFrame(() => this.render(true));
  };

  private readonly reposition = () => this.render(false);

  private render(restartBlink: boolean) {
    const { view } = this;
    const pos = caretPosition(view);
    if (pos === null || view.composing || view.root.activeElement !== view.dom) {
      this.hide();
      return;
    }

    const coords = caretCoords(view, pos);
    if (!coords) {
      // Never leave the native caret hidden behind an overlay that cannot be placed.
      this.hide();
      return;
    }

    const containerRect = this.container.getBoundingClientRect();
    const left = coords.left - containerRect.left + this.container.scrollLeft;
    const top = coords.top - containerRect.top + this.container.scrollTop;
    const height = coords.bottom - coords.top;

    if (!this.element) {
      this.element = this.container.appendChild(document.createElement('div'));
      this.element.className = 'editor-caret';
    }
    view.dom.classList.add(ACTIVE_CLASS);
    const element = this.element;
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${top}px`;
    element.style.width = `${CARET_WIDTH}px`;
    element.style.height = `${height}px`;

    const key = `${pos}:${left}:${top}`;
    if (restartBlink && key !== this.lastKey) {
      element.classList.remove('editor-caret-blink');
      void element.offsetWidth;
      element.classList.add('editor-caret-blink');
    }
    this.lastKey = key;
  }

  private hide() {
    this.view.dom.classList.remove(ACTIVE_CLASS);
    this.element?.remove();
    this.element = null;
    this.lastKey = '';
  }
}
