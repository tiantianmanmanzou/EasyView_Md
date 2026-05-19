/**
 * LinkEditPopup — popup for creating and editing links.
 */

import { EditorView } from 'prosemirror-view';
import { TextSelection } from 'prosemirror-state';
import { getMarkRange } from '../../../editor/lib/MarkRange';
import { addLink, updateLink, removeLink } from './ToolbarLinkCommands';

export class LinkEditPopup {
  private el: HTMLDivElement;
  private input: HTMLInputElement;
  private applyBtn: HTMLButtonElement;
  private removeBtn: HTMLButtonElement;
  private openBtn: HTMLButtonElement;
  private view: EditorView | null = null;
  private isVisible = false;
  private isNew = false; // true = creating new link, false = editing existing
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'link-edit-popup';

    this.input = document.createElement('input');
    this.input.className = 'link-edit-input';
    this.input.type = 'url';
    this.input.placeholder = 'Enter URL...';
    this.input.spellcheck = false;

    // Prevent ProseMirror from stealing keystrokes
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });

    // Apply button (checkmark)
    this.applyBtn = document.createElement('button');
    this.applyBtn.className = 'link-edit-btn';
    this.applyBtn.title = 'Apply';
    this.applyBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    this.applyBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.apply();
    });

    // Remove link button (unlink)
    this.removeBtn = document.createElement('button');
    this.removeBtn.className = 'link-edit-btn';
    this.removeBtn.title = 'Remove link';
    this.removeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/></svg>';
    this.removeBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.remove();
    });

    // Open link button (external)
    this.openBtn = document.createElement('button');
    this.openBtn.className = 'link-edit-btn';
    this.openBtn.title = 'Open link';
    this.openBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    this.openBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.openLink();
    });

    this.el.appendChild(this.input);
    this.el.appendChild(this.applyBtn);
    this.el.appendChild(this.removeBtn);
    this.el.appendChild(this.openBtn);
    document.body.appendChild(this.el);
  }

  /** Show the popup for creating a new link or editing an existing one */
  show(view: EditorView, existingHref?: string) {
    this.view = view;
    this.isNew = !existingHref;
    // Decode URI for display (Cyrillic characters get URL-encoded by markdown-it)
    let displayHref = existingHref || '';
    try { displayHref = decodeURI(displayHref); } catch { /* keep as-is */ }
    this.input.value = displayHref;

    // Show/hide remove and open buttons based on context
    this.removeBtn.style.display = existingHref ? '' : 'none';
    this.openBtn.style.display = existingHref ? '' : 'none';

    this.el.classList.add('visible');
    this.isVisible = true;

    this.updatePosition(view);

    // Focus input after a tick so the popup is positioned
    requestAnimationFrame(() => this.input.focus());

    // Click outside to close
    if (!this.outsideClickHandler) {
      this.outsideClickHandler = (e: MouseEvent) => {
        if (!this.el.contains(e.target as Node)) {
          this.hide();
        }
      };
      setTimeout(() => {
        document.addEventListener('mousedown', this.outsideClickHandler!);
      }, 0);
    }
  }

  /** Toggle popup: if visible, hide; otherwise open for current selection/link */
  toggle(view: EditorView) {
    if (this.isVisible) {
      this.hide();
      return;
    }

    const { state } = view;
    const { $from, empty } = state.selection;

    // Check if cursor is on an existing link
    const range = getMarkRange($from, state.schema.marks.link);
    if (range && range.mark) {
      // Select the full link text
      const tr = state.tr.setSelection(
        TextSelection.create(state.doc, range.from, range.to)
      );
      view.dispatch(tr);
      this.show(view, range.mark.attrs.href);
    } else if (!empty) {
      // Text selected, create new link
      this.show(view);
    } else {
      // No selection and no link — nothing to do
      return;
    }
  }

  hide() {
    this.el.classList.remove('visible');
    this.isVisible = false;

    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
      this.outsideClickHandler = null;
    }

    // Return focus to editor
    if (this.view) {
      this.view.focus();
    }
  }

  get visible() {
    return this.isVisible;
  }

  private apply() {
    if (!this.view) return;
    const href = this.input.value.trim();
    if (!href) return;

    if (this.isNew) {
      addLink({ href })(this.view.state, this.view.dispatch);
    } else {
      updateLink({ href })(this.view.state, this.view.dispatch);
    }

    this.hide();
  }

  private remove() {
    if (!this.view) return;
    removeLink()(this.view.state, this.view.dispatch);
    this.hide();
  }

  private openLink() {
    const href = this.input.value.trim();
    if (!href) return;
    // Dispatch custom event — index.ts listens and forwards to extension host
    window.dispatchEvent(new CustomEvent('inlinemd:openLink', { detail: { url: href } }));
  }

  private updatePosition(view: EditorView) {
    const { from, to } = view.state.selection;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);

    const popupRect = this.el.getBoundingClientRect();

    // Position below selection
    const centerX = (start.left + end.right) / 2;
    let left = centerX - popupRect.width / 2;
    const top = end.bottom + 8;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - popupRect.width - 8));

    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.min(top, window.innerHeight - popupRect.height - 8)}px`;
  }

  destroy() {
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler);
    }
    this.el.remove();
  }
}

export const linkEditPopup = new LinkEditPopup();
