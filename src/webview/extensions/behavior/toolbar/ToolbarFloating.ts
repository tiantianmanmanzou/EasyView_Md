/**
 * FloatingToolbar — the main floating formatting toolbar that appears on text selection.
 */

import { EditorView } from 'prosemirror-view';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { gripSelectionKey } from '../../blocks/table/GripSelectionPlugin';
import { htmlTagDropdown } from './ToolbarHtmlDropdown';
import { buttons } from './ToolbarButtons';

// ─── FloatingToolbar ─────────────────────────────────────────────────────────

export class FloatingToolbar {
  private el: HTMLDivElement;
  private view: EditorView | null = null;
  private isVisible = false;
  private mouseDown = false;
  private pendingShow = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'floating-toolbar';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', 'Formatting toolbar');
    this.render();
    document.body.appendChild(this.el);

    document.addEventListener('mousedown', (e) => {
      // Ignore clicks on the toolbar itself
      if (this.el.contains(e.target as Node)) return;
      this.mouseDown = true;
      this.pendingShow = false;
    });
    document.addEventListener('mouseup', () => {
      this.mouseDown = false;
      if (this.pendingShow && this.view) {
        this.pendingShow = false;
        const hasImage = this.selectionContainsImage(this.view.state);
        this.setImageMode(hasImage);
        this.show();
        this.updatePosition(this.view);
        this.updateActiveStates();
      }
    });
  }

  private render() {
    this.el.innerHTML = '';
    for (const btn of buttons) {
      if (btn.id.startsWith('separator')) {
        const sep = document.createElement('div');
        sep.className = 'toolbar-separator';
        this.el.appendChild(sep);
        continue;
      }

      const button = document.createElement('button');
      button.className = 'toolbar-button';
      button.innerHTML = btn.icon;
      button.title = btn.title;
      button.dataset.command = btn.id;
      button.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent focus loss
        if (this.view) {
          btn.command(this.view.state, this.view.dispatch, this.view);
          this.view.focus();
          this.updateActiveStates();
        }
      });
      this.el.appendChild(button);
    }
  }

  attach(view: EditorView) {
    this.view = view;
  }

  update(view: EditorView) {
    this.view = view;
    const { state } = view;
    const { selection } = state;
    const { empty, $from, $to } = selection;

    // Hide toolbar during drag operations
    if ((view as any).dragging) {
      this.hide();
      this.pendingShow = false;
      return;
    }

    // Check if this is a grip selection
    const gripState = gripSelectionKey.getState(state);
    const isGripSelection = gripState?.isGripSelection || false;

    // Check if this is a node selection (image, etc.)
    const isNodeSelection = selection instanceof NodeSelection;

    // Hide toolbar if selection is empty, inside a code block, is a grip selection, or is a node selection
    if (empty || $from.parent.type.spec.code || isGripSelection || isNodeSelection) {
      this.hide();
      this.pendingShow = false;
      return;
    }

    // Defer showing until mouse is released
    if (this.mouseDown) {
      this.pendingShow = true;
      return;
    }

    // Check if range selection contains any inline atom (image)
    const hasImage = this.selectionContainsImage(state);
    this.setImageMode(hasImage);

    this.show();
    this.updatePosition(view);
    this.updateActiveStates();
  }

  private show() {
    if (!this.isVisible) {
      this.el.classList.add('visible');
      this.isVisible = true;
    }
  }

  private hide() {
    if (this.isVisible) {
      this.el.classList.remove('visible');
      this.isVisible = false;
      htmlTagDropdown.hide();
    }
  }

  /** Hide toolbar from outside (e.g. when switching to source mode) */
  forceHide() {
    this.hide();
  }

  private updatePosition(view: EditorView) {
    const { from, to } = view.state.selection;
    const start = view.coordsAtPos(from);
    const end = view.coordsAtPos(to);

    const toolbarRect = this.el.getBoundingClientRect();

    // Center toolbar above selection
    const centerX = (start.left + end.right) / 2;
    let left = centerX - toolbarRect.width / 2;
    const top = start.top - toolbarRect.height - 8;

    // Keep within viewport
    left = Math.max(8, Math.min(left, window.innerWidth - toolbarRect.width - 8));

    this.el.style.left = `${left}px`;
    this.el.style.top = `${Math.max(8, top)}px`;
  }

  /** Check if range selection contains an inline atom node (image) */
  private selectionContainsImage(state: EditorState): boolean {
    const { from, to } = state.selection;
    let found = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (found) return false;
      if (node.type.name === 'image') {
        found = true;
        return false;
      }
    });
    return found;
  }

  /** IDs of buttons allowed when an image is selected */
  private static IMAGE_MODE_IDS = new Set([
    'blockquote',
    'checkbox-list', 'bullet-list', 'ordered-list',
    'notice-note', 'notice-tip', 'notice-important', 'notice-caution', 'notice-warning',
  ]);

  /** Show only block-level buttons when image is selected */
  private setImageMode(isImage: boolean) {
    const buttonEls = this.el.querySelectorAll('.toolbar-button');
    const separatorEls = this.el.querySelectorAll('.toolbar-separator');
    let idx = 0;
    let sepIdx = 0;

    for (const btn of buttons) {
      if (btn.id.startsWith('separator')) {
        const sep = separatorEls[sepIdx++] as HTMLElement;
        if (sep) sep.style.display = isImage ? 'none' : '';
        continue;
      }
      const el = buttonEls[idx++] as HTMLElement;
      if (!el) continue;

      if (isImage) {
        el.style.display = FloatingToolbar.IMAGE_MODE_IDS.has(btn.id) ? '' : 'none';
      } else {
        el.style.display = '';
      }
    }

    // Show separators between visible groups in image mode
    if (isImage) {
      // Show separator between blockquote and lists (separator-1)
      const sep1 = separatorEls[1] as HTMLElement;
      if (sep1) sep1.style.display = '';
      // Show separator between lists and notices (separator-3)
      const sep3 = separatorEls[3] as HTMLElement;
      if (sep3) sep3.style.display = '';
    }
  }

  private updateActiveStates() {
    if (!this.view) return;
    const state = this.view.state;

    const buttonEls = this.el.querySelectorAll('.toolbar-button');
    const separatorEls = this.el.querySelectorAll('.toolbar-separator');
    let idx = 0;
    let sepIdx = 0;

    for (const btn of buttons) {
      if (btn.id.startsWith('separator')) {
        // Track separator for conditional visibility
        const sep = separatorEls[sepIdx++] as HTMLElement;
        if (sep && btn.id === 'separator-7') {
          // The separator before interpret-markdown: shown only when the button is visible
          const nextBtn = buttons[buttons.indexOf(btn) + 1];
          if (nextBtn?.visible) {
            sep.style.display = nextBtn.visible(state) ? '' : 'none';
          }
        }
        continue;
      }
      const el = buttonEls[idx++] as HTMLElement;
      if (!el) continue;

      // Handle conditional visibility
      if (btn.visible) {
        el.style.display = btn.visible(state) ? '' : 'none';
      }

      if (btn.isActive?.(state)) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  }

  destroy() {
    this.el.remove();
  }
}
