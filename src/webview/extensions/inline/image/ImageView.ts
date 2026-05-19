/**
 * ImageView — custom NodeView for image nodes
 *
 * Wraps <img> in a container, handles selection visual,
 * triggers the image toolbar on click, and provides resize handles.
 *
 * Selection is handled via handleClickOn in EditorView props (index.ts),
 * NOT via stopEvent — because stopEvent blocks ProseMirror's MouseDown
 * creation, which removes the selectionchange guard and causes
 * NodeSelection to be overwritten by TextSelection from DOM.
 */

import type { Node } from 'prosemirror-model';
import type { EditorView, NodeView } from 'prosemirror-view';

type HandlePosition = 'nw' | 'ne' | 'sw' | 'se';

export class ImageView implements NodeView {
  dom: HTMLElement;
  private img: HTMLImageElement;
  private node: Node;
  private view: EditorView;
  private getPos: () => number | undefined;
  private handles: HTMLElement[] = [];
  private isSelected = false;
  private resizing = false;

  constructor(node: Node, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    // Wrapper — <span> because image is inline
    this.dom = document.createElement('span');
    this.dom.className = 'image-view-wrapper';
    this.dom.contentEditable = 'false';

    // Image element
    this.img = document.createElement('img');
    this.syncAttrs();
    this.dom.appendChild(this.img);

    // Create resize handles (hidden by default)
    this.createHandles();
  }

  private syncAttrs() {
    const { src, originalSrc, alt, title, width, height } = this.node.attrs;
    this.img.src = src || '';
    if (originalSrc) this.img.dataset.originalSrc = originalSrc;
    else delete this.img.dataset.originalSrc;
    if (alt) this.img.alt = alt; else this.img.removeAttribute('alt');
    if (title) this.img.title = title; else this.img.removeAttribute('title');
    if (width) {
      this.img.style.width = typeof width === 'number' || /^\d+$/.test(width)
        ? `${width}px` : width;
      this.img.removeAttribute('width');
    } else {
      this.img.style.width = '';
      this.img.removeAttribute('width');
    }
    if (height) {
      this.img.style.height = typeof height === 'number' || /^\d+$/.test(height)
        ? `${height}px` : height;
      this.img.removeAttribute('height');
    } else {
      this.img.style.height = '';
      this.img.removeAttribute('height');
    }
  }

  private createHandles() {
    const positions: HandlePosition[] = ['nw', 'ne', 'sw', 'se'];
    for (const pos of positions) {
      const handle = document.createElement('span');
      handle.className = `image-resize-handle image-resize-${pos}`;
      handle.contentEditable = 'false';
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startResize(e, pos);
      });
      this.dom.appendChild(handle);
      this.handles.push(handle);
    }
  }

  private startResize(e: MouseEvent, handlePos: HandlePosition) {
    this.resizing = true;
    this.dom.classList.add('image-resizing');

    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = this.img.offsetWidth;
    const startHeight = this.img.offsetHeight;
    const aspectRatio = startWidth / startHeight;

    // Determine resize direction
    const isLeft = handlePos === 'nw' || handlePos === 'sw';
    const isTop = handlePos === 'nw' || handlePos === 'ne';

    const onMouseMove = (moveEvent: MouseEvent) => {
      let dx = moveEvent.clientX - startX;
      let dy = moveEvent.clientY - startY;

      // Flip direction for left/top handles
      if (isLeft) dx = -dx;
      if (isTop) dy = -dy;

      // Calculate new size maintaining aspect ratio
      let newWidth: number;
      if (Math.abs(dx) > Math.abs(dy)) {
        newWidth = Math.max(50, startWidth + dx);
      } else {
        const newHeight = Math.max(50, startHeight + dy);
        newWidth = newHeight * aspectRatio;
      }

      // Clamp to container width
      const containerWidth = this.dom.parentElement?.clientWidth || 800;
      newWidth = Math.min(newWidth, containerWidth);

      this.img.style.width = `${Math.round(newWidth)}px`;
      this.img.style.height = 'auto';
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      this.resizing = false;
      this.dom.classList.remove('image-resizing');

      // Commit the new width to ProseMirror
      const finalWidth = Math.round(this.img.offsetWidth);
      const pos = this.getPos();
      if (pos !== undefined) {
        const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
          ...this.node.attrs,
          width: String(finalWidth),
          height: null, // Let height be auto via aspect ratio
        });
        this.view.dispatch(tr);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.syncAttrs();
    return true;
  }

  selectNode() {
    this.isSelected = true;
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode() {
    this.isSelected = false;
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  stopEvent(event: Event): boolean {
    // Allow resize handle mouse events to be processed
    if (this.resizing) return true;
    return false;
  }

  ignoreMutation(mutation: MutationRecord | { type: string }): boolean {
    if (mutation.type === 'selection') return false;
    return true;
  }
}
