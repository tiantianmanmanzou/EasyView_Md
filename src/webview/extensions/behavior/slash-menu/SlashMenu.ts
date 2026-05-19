/**
 * Slash Command Menu
 *
 * Triggered by typing '/' at the start of an empty paragraph.
 * Shows a filterable dropdown of block types to insert.
 * Inspired by Outline's BlockMenu extension.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { defaultSlashItems } from './SlashMenuItems';


// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlashMenuItem {
  id: string;
  label: string;
  icon: string;
  keywords: string[];
  /** Group for visual separators between categories */
  group: string;
  /** Receives the view and the range [parentStart, parentEnd] of the paragraph to replace */
  command: (view: EditorView, parentStart: number, parentEnd: number) => void;
}

// ─── Slash Menu View (DOM) ──────────────────────────────────────────────────

class SlashMenuView {
  private el: HTMLDivElement;
  private items: SlashMenuItem[];
  private filteredItems: SlashMenuItem[];
  private selectedIndex = 0;
  private _isOpen = false;
  private _triggerPos = -1;
  private _parentStart = -1;
  private _parentEnd = -1;
  private view: EditorView;

  constructor(view: EditorView, items: SlashMenuItem[]) {
    this.view = view;
    this.items = items;
    this.filteredItems = items;
    this.el = document.createElement('div');
    this.el.className = 'slash-menu';
    this.el.style.display = 'none';
    document.body.appendChild(this.el);
  }

  get isOpen() { return this._isOpen; }

  open(parentStart: number, parentEnd: number, triggerPos: number, filter: string) {
    this._parentStart = parentStart;
    this._parentEnd = parentEnd;
    this._triggerPos = triggerPos;
    this.filterItems(filter);
    if (this.filteredItems.length === 0) { this.close(); return; }
    this.selectedIndex = 0;
    this._isOpen = true;
    this.render();
    this.position();
    this.el.style.display = '';
  }

  close() {
    this._isOpen = false;
    this.el.style.display = 'none';
    this._triggerPos = -1;
  }

  handleKeyDown(event: KeyboardEvent): boolean {
    if (!this._isOpen) return false;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.selectedIndex = (this.selectedIndex + 1) % this.filteredItems.length;
        this.render();
        return true;
      case 'ArrowUp':
        event.preventDefault();
        this.selectedIndex = (this.selectedIndex - 1 + this.filteredItems.length) % this.filteredItems.length;
        this.render();
        return true;
      case 'Enter':
        event.preventDefault();
        this.execute();
        return true;
      case 'Escape':
        event.preventDefault();
        this.close();
        return true;
    }
    return false;
  }

  updateFilter(parentStart: number, parentEnd: number, filter: string) {
    this._parentStart = parentStart;
    this._parentEnd = parentEnd;
    this.filterItems(filter);
    if (this.filteredItems.length === 0) { this.close(); return; }
    this.selectedIndex = Math.min(this.selectedIndex, this.filteredItems.length - 1);
    this.render();
    this.position();
  }

  private execute() {
    const item = this.filteredItems[this.selectedIndex];
    if (!item) return;
    const parentStart = this._parentStart;
    const parentEnd = this._parentEnd;
    this.close();
    this.view.focus();
    // Replace the ENTIRE paragraph (including the / text) with the target block
    // This is a single-transaction approach — much more reliable
    item.command(this.view, parentStart, parentEnd);
  }

  private filterItems(filter: string) {
    if (!filter) { this.filteredItems = this.items; return; }
    const lower = filter.toLowerCase();
    this.filteredItems = this.items.filter(item =>
      item.label.toLowerCase().includes(lower) ||
      item.keywords.some(k => k.includes(lower))
    );
  }

  private render() {
    this.el.innerHTML = '';
    let lastGroup = '';
    const isFiltered = this.filteredItems.length !== this.items.length;
    for (let i = 0; i < this.filteredItems.length; i++) {
      const item = this.filteredItems[i];
      // Add separator between groups (only when not filtered)
      if (!isFiltered && item.group !== lastGroup && lastGroup !== '') {
        this.el.appendChild(document.createElement('hr'));
      }
      lastGroup = item.group;
      const div = document.createElement('div');
      div.className = `slash-menu-item${i === this.selectedIndex ? ' selected' : ''}`;
      div.innerHTML = `
        <div class="slash-menu-item-icon">${item.icon}</div>
        <div class="slash-menu-item-label">${item.label}</div>
      `;
      div.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.selectedIndex = i;
        this.execute();
      });
      div.addEventListener('mouseenter', () => {
        this.selectedIndex = i;
        const items = this.el.querySelectorAll('.slash-menu-item');
        items.forEach((el, idx) => el.classList.toggle('selected', idx === i));
      });
      this.el.appendChild(div);
    }
    const selected = this.el.querySelector('.selected') as HTMLElement;
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }

  private position() {
    try {
      const coords = this.view.coordsAtPos(this._triggerPos);
      let left = coords.left;
      let top = coords.bottom + 6;
      if (left + 260 > window.innerWidth) left = window.innerWidth - 268;
      if (top + 320 > window.innerHeight) top = coords.top - 326;
      this.el.style.left = `${Math.max(8, left)}px`;
      this.el.style.top = `${top}px`;
      this.el.style.position = 'fixed';
    } catch { /* position failed */ }
  }

  destroy() { this.el.remove(); }
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const slashMenuKey = new PluginKey('slashMenu');

export function slashMenuPlugin(items: SlashMenuItem[] = defaultSlashItems): Plugin {
  let menuView: SlashMenuView | null = null;
  let shouldOpenMenu = false;

  return new Plugin({
    key: slashMenuKey,
    state: {
      init() { return null; },
      apply(tr, value) {
        // Check if menu should be opened via metadata
        const meta = tr.getMeta(slashMenuKey);
        if (meta?.openMenu) {
          shouldOpenMenu = true;
        }
        return value;
      }
    },
    view(editorView) {
      menuView = new SlashMenuView(editorView, items);
      return {
        update(view, prevState) {
          if (!menuView) return;
          const { state } = view;
          const { selection } = state;
          const { $from, empty } = selection as any;

          // Check if menu should be opened via metadata (from plus button)
          if (shouldOpenMenu && empty && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0) {
            shouldOpenMenu = false; // Reset flag
            const triggerPos = $from.start();
            const parentStart = $from.before();
            const parentEnd = $from.after();
            menuView.open(parentStart, parentEnd, triggerPos, '');
            return;
          }
          shouldOpenMenu = false; // Reset if conditions not met

          if (!empty || $from.parent.type.spec.code) {
            menuView.close();
            return;
          }

          const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc');
          const slashMatch = textBefore.match(/^\/(\S*)$/);

          if (slashMatch) {
            const triggerPos = $from.start();
            const parentStart = $from.before();
            const parentEnd = $from.after();
            const filter = slashMatch[1];
            if (!menuView.isOpen) {
              menuView.open(parentStart, parentEnd, triggerPos, filter);
            } else {
              menuView.updateFilter(parentStart, parentEnd, filter);
            }
          } else {
            menuView.close();
          }
        },
        destroy() {
          menuView?.destroy();
          menuView = null;
        },
      };
    },
    props: {
      handleKeyDown(view, event) {
        return menuView?.handleKeyDown(event) ?? false;
      },
    },
  });
}
