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
  private previewBtn: HTMLButtonElement;
  private replaceUrlBtn: HTMLButtonElement;
  private browseBtn: HTMLButtonElement;
  private deleteBtn: HTMLButtonElement;
  private applyUrlBtn: HTMLButtonElement;
  private previewOverlay: HTMLDivElement | null = null;
  private previewImage: HTMLImageElement | null = null;
  private previewCaption: HTMLDivElement | null = null;
  private view: EditorView | null = null;
  private isVisible = false;
  private currentPos = -1;
  private currentPreviewSrc = '';
  private currentPreviewAlt = '';
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private activeDom: HTMLElement | null = null;

  constructor() {
    ensureImagePreviewStyles();

    this.el = document.createElement('div');
    this.el.className = 'image-toolbar';

    // ── Source display row ──
    this.srcRow = document.createElement('div');
    this.srcRow.className = 'image-toolbar-row';

    this.srcDisplay = document.createElement('span');
    this.srcDisplay.className = 'image-toolbar-src';

    // Preview large image button
    this.previewBtn = document.createElement('button');
    this.previewBtn.className = 'link-edit-btn';
    this.previewBtn.title = 'View image';
    this.previewBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    this.previewBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openPreview();
    });

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
    this.srcRow.appendChild(this.previewBtn);
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
    const img = dom.querySelector('img') as HTMLImageElement | null;
    this.currentPreviewSrc = img?.currentSrc || img?.src || node.attrs.src || src;
    this.currentPreviewAlt = node.attrs.alt || '';
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

  preview(src: string, alt = '', caption = '') {
    this.openPreview(src, alt, caption);
  }

  private updatePosition(dom: HTMLElement) {
    const rect = dom.getBoundingClientRect();
    const popupWidth = this.el.offsetWidth;
    const popupHeight = this.el.offsetHeight;
    let left = rect.right - popupWidth;
    let top = rect.top - popupHeight - 8;

    // Prefer top-right. If there is no room above, overlay near the image's top-right.
    if (top < 8) {
      top = rect.top + 8;
    }

    // Keep within viewport.
    left = Math.max(8, Math.min(left, window.innerWidth - popupWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - popupHeight - 8));

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

  private ensurePreviewModal() {
    if (this.previewOverlay && this.previewImage && this.previewCaption) return;

    this.previewOverlay = document.createElement('div');
    this.previewOverlay.className = 'image-preview-modal';
    this.previewOverlay.addEventListener('mousedown', (e) => {
      if (e.target === this.previewOverlay) {
        e.preventDefault();
        this.closePreview();
      }
    });

    const dialog = document.createElement('div');
    dialog.className = 'image-preview-dialog';
    dialog.addEventListener('mousedown', (e) => e.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.className = 'image-preview-close';
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    closeBtn.addEventListener('click', () => this.closePreview());

    this.previewImage = document.createElement('img');
    this.previewImage.className = 'image-preview-img';
    this.previewImage.draggable = false;

    this.previewCaption = document.createElement('div');
    this.previewCaption.className = 'image-preview-caption';

    dialog.appendChild(closeBtn);
    dialog.appendChild(this.previewImage);
    dialog.appendChild(this.previewCaption);
    this.previewOverlay.appendChild(dialog);
    document.body.appendChild(this.previewOverlay);
  }

  private openPreview(src = this.currentPreviewSrc, alt = this.currentPreviewAlt, caption = this.srcDisplay.title) {
    if (!src) return;

    this.ensurePreviewModal();
    if (!this.previewOverlay || !this.previewImage || !this.previewCaption) return;

    this.previewImage.src = src;
    this.previewImage.alt = alt || '';
    this.previewCaption.textContent = alt || caption || src;
    this.previewOverlay.classList.add('open');

    const existingHandler = (this.previewOverlay as any).__imagePreviewKeydown as ((event: KeyboardEvent) => void) | undefined;
    if (existingHandler) {
      document.removeEventListener('keydown', existingHandler);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      this.closePreview();
    };
    this.previewOverlay.dataset.keyHandlerBound = 'true';
    (this.previewOverlay as any).__imagePreviewKeydown = onKeyDown;
    document.addEventListener('keydown', onKeyDown);
  }

  private closePreview() {
    if (!this.previewOverlay) return;
    this.previewOverlay.classList.remove('open');
    const handler = (this.previewOverlay as any).__imagePreviewKeydown as ((event: KeyboardEvent) => void) | undefined;
    if (handler) {
      document.removeEventListener('keydown', handler);
      delete (this.previewOverlay as any).__imagePreviewKeydown;
    }
  }

  destroy() {
    this.closePreview();
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
    }
    this.previewOverlay?.remove();
    this.el.remove();
  }
}

export const imageToolbar = new ImageToolbar();

function ensureImagePreviewStyles() {
  const styleId = 'easyview-image-preview-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .image-preview-modal {
      position: fixed;
      inset: 0;
      z-index: 2000;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 32px;
      background: rgba(0, 0, 0, 0.72);
      backdrop-filter: blur(2px);
    }
    .image-preview-modal.open {
      display: flex;
    }
    .image-preview-dialog {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: center;
      max-width: min(96vw, 1800px);
      max-height: 94vh;
      padding: 14px;
      border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.32));
      border-radius: 10px;
      background: var(--vscode-editorWidget-background, #252526);
      box-shadow: 0 18px 56px rgba(0, 0, 0, 0.55);
    }
    .image-preview-img {
      display: block;
      max-width: calc(96vw - 64px);
      max-height: calc(94vh - 96px);
      width: auto;
      height: auto;
      object-fit: contain;
      border-radius: 6px;
      background: var(--vscode-editor-background, #1e1e1e);
    }
    .image-preview-caption {
      max-width: calc(96vw - 64px);
      margin-top: 10px;
      color: var(--vscode-descriptionForeground, #9d9d9d);
      font-size: 12px;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .image-preview-close {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, 0.35));
      border-radius: 999px;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-icon-foreground, #c5c5c5);
      cursor: pointer;
    }
    .image-preview-close:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.12));
      color: var(--vscode-editor-foreground, #fff);
    }
  `;
  document.head.appendChild(style);
}
