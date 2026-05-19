/**
 * ImageToolbar — toolbar for editing image properties (src, alt, delete).
 */

import { EditorView } from 'prosemirror-view';

export class ImageToolbar {
  private el: HTMLDivElement;
  private srcDisplay: HTMLSpanElement;
  private altInput: HTMLInputElement;
  private urlInput: HTMLInputElement;
  private urlRow: HTMLDivElement;
  private srcRow: HTMLDivElement;
  private replaceUrlBtn: HTMLButtonElement;
  private browseBtn: HTMLButtonElement;
  private deleteBtn: HTMLButtonElement;
  private applyUrlBtn: HTMLButtonElement;
  private view: EditorView | null = null;
  private isVisible = false;
  private currentPos = -1;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private activeDom: HTMLElement | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'image-toolbar';

    // ── Source display row ──
    this.srcRow = document.createElement('div');
    this.srcRow.className = 'image-toolbar-row';

    this.srcDisplay = document.createElement('span');
    this.srcDisplay.className = 'image-toolbar-src';

    // Replace with URL button
    this.replaceUrlBtn = document.createElement('button');
    this.replaceUrlBtn.className = 'link-edit-btn';
    this.replaceUrlBtn.title = 'Replace with URL';
    this.replaceUrlBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    this.replaceUrlBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.showUrlInput();
    });

    // Browse file button
    this.browseBtn = document.createElement('button');
    this.browseBtn.className = 'link-edit-btn';
    this.browseBtn.title = 'Browse for image...';
    this.browseBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    this.browseBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.requestFilePicker();
    });

    // Delete button
    this.deleteBtn = document.createElement('button');
    this.deleteBtn.className = 'link-edit-btn';
    this.deleteBtn.title = 'Delete image';
    this.deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    this.deleteBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.deleteImage();
    });

    this.srcRow.appendChild(this.srcDisplay);
    this.srcRow.appendChild(this.replaceUrlBtn);
    this.srcRow.appendChild(this.browseBtn);
    this.srcRow.appendChild(this.deleteBtn);
    this.el.appendChild(this.srcRow);

    // ── URL input row (hidden by default) ──
    this.urlRow = document.createElement('div');
    this.urlRow.className = 'image-toolbar-row';
    this.urlRow.style.display = 'none';

    this.urlInput = document.createElement('input');
    this.urlInput.className = 'link-edit-input';
    this.urlInput.type = 'url';
    this.urlInput.placeholder = 'Enter image URL...';
    this.urlInput.spellcheck = false;
    this.urlInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.applyUrl(); }
      if (e.key === 'Escape') { e.preventDefault(); this.hideUrlInput(); }
    });

    this.applyUrlBtn = document.createElement('button');
    this.applyUrlBtn.className = 'link-edit-btn';
    this.applyUrlBtn.title = 'Apply';
    this.applyUrlBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    this.applyUrlBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.applyUrl();
    });

    this.urlRow.appendChild(this.urlInput);
    this.urlRow.appendChild(this.applyUrlBtn);
    this.el.appendChild(this.urlRow);

    // ── Alt text row ──
    const altRow = document.createElement('div');
    altRow.className = 'image-toolbar-row';

    const altLabel = document.createElement('span');
    altLabel.className = 'image-toolbar-label';
    altLabel.textContent = 'Alt';

    this.altInput = document.createElement('input');
    this.altInput.className = 'image-toolbar-alt-input';
    this.altInput.type = 'text';
    this.altInput.placeholder = 'Alt text...';
    this.altInput.spellcheck = false;
    this.altInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); this.applyAlt(); this.hide(); }
      if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
    });
    this.altInput.addEventListener('blur', () => {
      this.applyAlt();
    });

    altRow.appendChild(altLabel);
    altRow.appendChild(this.altInput);
    this.el.appendChild(altRow);

    document.body.appendChild(this.el);
  }

  show(view: EditorView, pos: number, node: any, dom: HTMLElement) {
    this.view = view;
    this.currentPos = pos;

    // Remove active class from previous image
    if (this.activeDom) this.activeDom.classList.remove('image-toolbar-active');
    // Add active class to current image (independent of ProseMirror NodeSelection)
    this.activeDom = dom;
    if (dom) {
      dom.classList.add('image-toolbar-active');
    }

    // Populate from node attrs
    const src = node.attrs.originalSrc || node.attrs.src || '';
    this.srcDisplay.textContent = this.truncate(src);
    this.srcDisplay.title = src;
    this.altInput.value = node.attrs.alt || '';

    // Reset URL input
    this.hideUrlInput();

    this.el.classList.add('visible');
    this.isVisible = true;

    // Position below image
    requestAnimationFrame(() => this.updatePosition(dom));

    // Click outside → close
    if (!this.outsideClickHandler) {
      this.outsideClickHandler = (e: MouseEvent) => {
        if (!this.el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.image-view-wrapper')) {
          this.hide();
        }
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this.outsideClickHandler!);
      }, 0);
    }
  }

  hide() {
    if (!this.isVisible) return;
    this.el.classList.remove('visible');
    this.isVisible = false;
    this.hideUrlInput();

    // Remove active class from image
    if (this.activeDom) {
      this.activeDom.classList.remove('image-toolbar-active');
      this.activeDom = null;
    }

    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }

    if (this.view) this.view.focus();
  }

  get visible() { return this.isVisible; }

  private updatePosition(dom: HTMLElement) {
    const rect = dom.getBoundingClientRect();
    const popupWidth = this.el.offsetWidth;
    const centerX = rect.left + rect.width / 2;
    let left = centerX - popupWidth / 2;
    let top = rect.bottom + 8;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
    if (top + this.el.offsetHeight > window.innerHeight - 8) {
      top = rect.top - this.el.offsetHeight - 8;
    }

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }

  private truncate(src: string): string {
    try { src = decodeURI(src); } catch { /* keep as-is */ }
    if (src.length > 45) return '...' + src.slice(-42);
    return src;
  }

  private showUrlInput() {
    this.srcRow.style.display = 'none';
    this.urlRow.style.display = '';
    this.urlInput.value = '';
    requestAnimationFrame(() => this.urlInput.focus());
  }

  private hideUrlInput() {
    this.srcRow.style.display = '';
    this.urlRow.style.display = 'none';
  }

  private applyUrl() {
    if (!this.view) return;
    const url = this.urlInput.value.trim();
    if (!url) return;

    const node = this.view.state.doc.nodeAt(this.currentPos);
    if (!node || node.type.name !== 'image') return;

    const tr = this.view.state.tr.setNodeMarkup(this.currentPos, undefined, {
      ...node.attrs,
      src: url,
      originalSrc: url,
    });
    this.view.dispatch(tr);
    this.hideUrlInput();

    // Update src display
    this.srcDisplay.textContent = this.truncate(url);
    this.srcDisplay.title = url;
  }

  private applyAlt() {
    if (!this.view) return;
    const node = this.view.state.doc.nodeAt(this.currentPos);
    if (!node || node.type.name !== 'image') return;
    const newAlt = this.altInput.value;
    if (newAlt === (node.attrs.alt || '')) return;

    const tr = this.view.state.tr.setNodeMarkup(this.currentPos, undefined, {
      ...node.attrs,
      alt: newAlt || null,
    });
    this.view.dispatch(tr);
  }

  private deleteImage() {
    if (!this.view) return;
    const node = this.view.state.doc.nodeAt(this.currentPos);
    if (!node) return;
    const tr = this.view.state.tr.delete(this.currentPos, this.currentPos + node.nodeSize);
    this.view.dispatch(tr);
    this.hide();
  }

  private requestFilePicker() {
    window.dispatchEvent(new CustomEvent('inlinemd:pickImage', {
      detail: { pos: this.currentPos },
    }));
  }

  destroy() {
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
    }
    this.el.remove();
  }
}

export const imageToolbar = new ImageToolbar();
