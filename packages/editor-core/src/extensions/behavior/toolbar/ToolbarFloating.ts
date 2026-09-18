/**
 * FloatingToolbar — the main floating formatting toolbar that appears on text selection.
 */

import { EditorView } from 'prosemirror-view';
import { EditorState, NodeSelection } from 'prosemirror-state';
import { gripSelectionKey } from '../../blocks/table/GripSelectionPlugin';
import { htmlTagDropdown } from './ToolbarHtmlDropdown';
import type { ToolbarButton } from '../../../editor/EditorCommands';
import { isMarkActive } from '../../../editor/EditorCommands';
import { createEditorDomContext, type EditorDomContext } from '../../../runtime/editorDomContext';


// ─── FloatingToolbar ─────────────────────────────────────────────────────────

function ensureFloatingToolbarColorStyles(document: Document): void {
  const styleId = 'easyview-floating-toolbar-color-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .floating-toolbar .toolbar-button {
      color: var(--toolbar-group-color, var(--vscode-editor-foreground, #e5e7eb));
      transition: color 140ms ease, background-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
    }

    .floating-toolbar .toolbar-button svg,
    .floating-toolbar .toolbar-button span {
      color: inherit;
    }

    .floating-toolbar .toolbar-button:hover {
      background: color-mix(in srgb, var(--toolbar-group-color, #94a3b8) 14%, transparent);
    }

    .floating-toolbar .toolbar-button.active {
      color: var(--toolbar-group-active, var(--toolbar-group-color, #f8fafc));
      background: color-mix(in srgb, var(--toolbar-group-color, #94a3b8) 20%, rgba(255, 255, 255, 0.06));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--toolbar-group-color, #94a3b8) 28%, transparent);
    }

    .floating-toolbar .toolbar-button[data-color-group="inline"] {
      --toolbar-group-color: #f6c453;
      --toolbar-group-active: #ffd978;
    }

    .floating-toolbar .toolbar-button[data-color-group="block"] {
      --toolbar-group-color: #7dd3fc;
      --toolbar-group-active: #b6ecff;
    }

    .floating-toolbar .toolbar-button[data-color-group="heading"] {
      --toolbar-group-color: #c4b5fd;
      --toolbar-group-active: #ddd6fe;
    }

    .floating-toolbar .toolbar-button[data-color-group="list"] {
      --toolbar-group-color: #86efac;
      --toolbar-group-active: #bbf7d0;
    }

    .floating-toolbar .toolbar-button[data-color-group="insert"] {
      --toolbar-group-color: #fda4af;
      --toolbar-group-active: #fecdd3;
    }

    .floating-toolbar .toolbar-button[data-color-group="path"] {
      --toolbar-group-color: #67e8f9;
      --toolbar-group-active: #a5f3fc;
    }

    .floating-toolbar .toolbar-button[data-color-group="utility"] {
      --toolbar-group-color: #cbd5e1;
      --toolbar-group-active: #f8fafc;
    }

    .easyview-text-color-popover {
      position: fixed;
      z-index: 10001;
      display: grid;
      grid-template-columns: repeat(6, 24px);
      gap: 6px;
      padding: 8px;
      border: 1px solid var(--vscode-editorWidget-border, rgba(127, 127, 127, 0.35));
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, #252526);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    }

    .easyview-text-color-swatch {
      width: 24px;
      height: 24px;
      border: 1px solid rgba(255, 255, 255, 0.24);
      border-radius: 5px;
      cursor: pointer;
    }

    .easyview-text-color-swatch:hover {
      outline: 2px solid var(--vscode-focusBorder, #007fd4);
      outline-offset: 1px;
    }
  `;
  document.head.appendChild(style);
}

function getButtonColorGroup(buttonId: string): string {
  if (['bold', 'italic', 'underline', 'strikethrough', 'highlight', 'text-color'].includes(buttonId)) return 'inline';
  if (['code', 'blockquote', 'html-tags'].includes(buttonId)) return 'block';
  if (['heading1', 'heading2', 'heading3'].includes(buttonId)) return 'heading';
  if (['checkbox-list', 'bullet-list', 'ordered-list'].includes(buttonId)) return 'list';
  if (['horizontal-rule', 'interpret-markdown'].includes(buttonId)) return 'insert';
  if (['link', 'copy-outline-path', 'copy-full-path'].includes(buttonId)) return 'path';
  return 'utility';
}

export class FloatingToolbar {
  private el: HTMLDivElement;
  private view: EditorView | null = null;
  private isVisible = false;
  private mouseDown = false;
  private pendingShow = false;
  private colorPopover: HTMLDivElement | null = null;
  private destroyed = false;
  private readonly buttons: ToolbarButton[];

  private readonly documentMouseDownHandler = (event: MouseEvent): void => {
    // Ignore clicks on the toolbar itself
    if (this.el.contains(event.target as Node) || this.colorPopover?.contains(event.target as Node)) return;
    this.closeTextColorPopover();
    this.mouseDown = true;
    this.pendingShow = false;
  };

  private readonly pointerReleasedHandler = (): void => {
    this.flushPendingShow();
  };

  private readonly documentMouseMoveHandler = (event: MouseEvent): void => {
    if (this.mouseDown && event.buttons === 0) this.flushPendingShow();
  };

  constructor(buttons: ToolbarButton[], private readonly dom: EditorDomContext = createEditorDomContext()) {
    this.buttons = buttons;
    ensureFloatingToolbarColorStyles(dom.document);
    this.el = this.dom.document.createElement('div');
    this.el.className = 'floating-toolbar';
    this.el.setAttribute('role', 'toolbar');
    this.el.setAttribute('aria-label', 'Formatting toolbar');
    this.render();
    this.dom.overlayRoot.appendChild(this.el);

    this.dom.root.addEventListener('mousedown', this.documentMouseDownHandler as EventListener);
    this.dom.root.addEventListener('mouseup', this.pointerReleasedHandler);
    // Webview can lose mouseup when the pointer leaves the host; recover on these.
    this.dom.window.addEventListener('pointerup', this.pointerReleasedHandler);
    this.dom.window.addEventListener('pointercancel', this.pointerReleasedHandler);
    this.dom.window.addEventListener('blur', this.pointerReleasedHandler);
    this.dom.root.addEventListener('mousemove', this.documentMouseMoveHandler as EventListener);
  }

  private flushPendingShow() {
    if (this.destroyed) return;
    this.mouseDown = false;
    if (!this.pendingShow || !this.view) return;
    this.pendingShow = false;
    const hasImage = this.selectionContainsImage(this.view.state);
    this.setImageMode(hasImage);
    this.show();
    this.updatePosition(this.view);
    this.updateActiveStates();
  }

  private render() {
    this.el.innerHTML = '';
    for (const btn of this.buttons) {
      if (btn.id.startsWith('separator')) {
        const sep = this.dom.document.createElement('div');
        sep.className = 'toolbar-separator';
        this.el.appendChild(sep);
        continue;
      }

      const button = this.dom.document.createElement('button');
      button.className = 'toolbar-button';
      button.innerHTML = btn.icon;
      button.title = btn.title;
      button.dataset.command = btn.id;
      button.dataset.colorGroup = getButtonColorGroup(btn.id);
      button.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent focus loss
        if (btn.id === 'text-color') {
          this.toggleTextColor(button);
          return;
        }
        if (this.view) {
          btn.command(this.view.state, this.view.dispatch, this.view);
          this.view.focus();
          this.updateActiveStates();
        }
      });
      this.el.appendChild(button);
    }
  }

  private toggleTextColor(anchor: HTMLButtonElement): void {
    if (this.destroyed) return;
    const view = this.view;
    if (!view || view.state.selection.empty) return;
    const mark = view.state.schema.marks.text_color;
    if (mark && isMarkActive(view.state, mark)) {
      view.dispatch(view.state.tr.removeMark(view.state.selection.from, view.state.selection.to, mark));
      view.focus();
      this.closeTextColorPopover();
      this.updateActiveStates();
      return;
    }
    this.openTextColorPopover(anchor);
  }

  private openTextColorPopover(anchor: HTMLButtonElement): void {
    if (this.destroyed) return;
    const view = this.view;
    if (!view || view.state.selection.empty) return;
    this.closeTextColorPopover();

    const rect = anchor.getBoundingClientRect();
    const selection = { from: view.state.selection.from, to: view.state.selection.to };
    const popover = this.dom.document.createElement('div');
    popover.className = 'easyview-text-color-popover';
    popover.setAttribute('aria-label', 'Text color picker');
    const colors = ['#111827', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#c026d3', '#d946ef', '#64748b', '#ffffff'];

    const applyColor = (color: string) => {
      const mark = view.state.schema.marks.text_color;
      if (!mark || selection.from === selection.to) return;
      view.dispatch(view.state.tr.addMark(selection.from, selection.to, mark.create({ color })));
      view.focus();
      this.updateActiveStates();
      this.closeTextColorPopover();
    };

    for (const color of colors) {
      const swatch = this.dom.document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'easyview-text-color-swatch';
      swatch.style.background = color;
      swatch.title = color;
      swatch.setAttribute('aria-label', `Set text color ${color}`);
      swatch.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyColor(color);
      });
      popover.appendChild(swatch);
    }

    this.dom.overlayRoot.appendChild(popover);
    const popoverRect = popover.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, this.dom.window.innerWidth - popoverRect.width - 8));
    const below = rect.bottom + 8;
    const top = below + popoverRect.height <= this.dom.window.innerHeight - 8
      ? below
      : Math.max(8, rect.top - popoverRect.height - 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    this.colorPopover = popover;
  }

  private closeTextColorPopover(): void {
    this.colorPopover?.remove();
    this.colorPopover = null;
  }

  attach(view: EditorView) {
    if (this.destroyed) return;
    this.view = view;
  }

  update(view: EditorView) {
    if (this.destroyed) return;
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
    if (this.destroyed) return;
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
    left = Math.max(8, Math.min(left, this.dom.window.innerWidth - toolbarRect.width - 8));

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
    'horizontal-rule',
  ]);

  /** Show only block-level buttons when image is selected */
  private setImageMode(isImage: boolean) {
    const buttonEls = this.el.querySelectorAll('.toolbar-button');
    const separatorEls = this.el.querySelectorAll('.toolbar-separator');
    let idx = 0;
    let sepIdx = 0;

    for (const btn of this.buttons) {
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

    for (const btn of this.buttons) {
      if (btn.id.startsWith('separator')) {
        // Track separator for conditional visibility
        const sep = separatorEls[sepIdx++] as HTMLElement;
        if (sep && btn.id === 'separator-7') {
          // The separator before interpret-markdown: shown only when the button is visible
          const nextBtn = this.buttons[this.buttons.indexOf(btn) + 1];
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    this.dom.root.removeEventListener('mousedown', this.documentMouseDownHandler as EventListener);
    this.dom.root.removeEventListener('mouseup', this.pointerReleasedHandler);
    this.dom.window.removeEventListener('pointerup', this.pointerReleasedHandler);
    this.dom.window.removeEventListener('pointercancel', this.pointerReleasedHandler);
    this.dom.window.removeEventListener('blur', this.pointerReleasedHandler);
    this.dom.root.removeEventListener('mousemove', this.documentMouseMoveHandler as EventListener);

    this.closeTextColorPopover();
    htmlTagDropdown.hide();
    this.view = null;
    this.mouseDown = false;
    this.pendingShow = false;
    this.isVisible = false;
    this.el.classList.remove('visible');
    this.el.innerHTML = '';
    this.el.remove();
  }
}
