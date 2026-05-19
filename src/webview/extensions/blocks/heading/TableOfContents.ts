/**
 * Table of Contents Sidebar
 *
 * Displays headings (h1-h3) from the ProseMirror document.
 * Click to scroll, active heading highlight on scroll.
 * Based on Outline's Contents.tsx component.
 */

import type { EditorView } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import scrollIntoView from 'scroll-into-view-if-needed';

// Outline: HEADING_OFFSET = 20
const HEADING_OFFSET = 20;

interface HeadingEntry {
  level: number;
  text: string;
  pos: number;
}

export class TableOfContents {
  private view: EditorView;
  private sidebar: HTMLElement | null = null;
  private tocList: HTMLElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private headings: HeadingEntry[] = [];
  private filterText = '';
  private isVisible = false;
  private activeIndex = -1;
  private scrollAreaEl: HTMLElement | null = null;
  private scrollHandler: (() => void) | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private clickedPos: number | null = null;
  private programmaticScroll = false;
  public sourceClickHandler: ((heading: { level: number; text: string }) => void) | null = null;
  private sourceScrollEl: HTMLElement | null = null;
  private sourceScrollHandler: (() => void) | null = null;
  private sourceGetActivePos: (() => number) | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.scrollAreaEl = document.getElementById('editor-scroll-area');
    this.createSidebar();
    this.attachScrollListener();
  }

  // ─── DOM Creation ────────────────────────────────────────────────────

  private createSidebar(): void {
    this.sidebar = document.createElement('div');
    this.sidebar.className = 'toc-sidebar hidden';

    // Header
    const header = document.createElement('div');
    header.className = 'toc-sidebar-header';
    header.textContent = 'Contents';
    this.sidebar.appendChild(header);

    // Filter input
    const filterWrapper = document.createElement('div');
    filterWrapper.className = 'toc-filter-wrapper';
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'text';
    this.filterInput.className = 'toc-filter-input';
    this.filterInput.placeholder = 'Filter...';
    this.filterInput.addEventListener('input', () => {
      this.filterText = (this.filterInput?.value || '').toLowerCase();
      this.renderList();
    });
    // Prevent editor from stealing focus on key events
    this.filterInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Escape') {
        this.filterInput!.value = '';
        this.filterText = '';
        this.renderList();
        this.view.focus();
      }
    });
    filterWrapper.appendChild(this.filterInput);
    this.sidebar.appendChild(filterWrapper);

    // List
    this.tocList = document.createElement('ul');
    this.tocList.className = 'toc-list';
    this.sidebar.appendChild(this.tocList);

    // Insert into #editor-body before #editor-scroll-area
    const editorBody = document.getElementById('editor-body');
    if (editorBody && this.scrollAreaEl) {
      editorBody.insertBefore(this.sidebar, this.scrollAreaEl);
    }
  }

  // ─── Heading Extraction ──────────────────────────────────────────────

  /**
   * Extract headings from document root level (level 1-3 only).
   * Based on Outline's ProsemirrorHelper.getHeadings()
   */
  private extractHeadings(doc: ProsemirrorNode): HeadingEntry[] {
    const headings: HeadingEntry[] = [];

    doc.forEach((node, offset) => {
      if (node.type.name === 'heading' && node.attrs.level < 4) {
        headings.push({
          level: node.attrs.level,
          text: node.textContent || '',
          pos: offset,
        });
      }
    });

    return headings;
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  /**
   * Rebuild the TOC list from current headings.
   * Outline normalizes levels: min heading becomes level 1.
   */
  private renderList(): void {
    if (!this.tocList) return;

    this.tocList.innerHTML = '';

    // Filter headings by search text
    const filtered = this.filterText
      ? this.headings.filter(h => h.text.toLowerCase().includes(this.filterText))
      : this.headings;

    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'toc-empty';
      empty.textContent = this.filterText ? 'No matches' : 'No headings found';
      this.tocList.appendChild(empty);
      return;
    }

    // Outline: normalize heading levels (min becomes 1)
    const minLevel = this.headings.reduce(
      (min, h) => (h.level < min ? h.level : min),
      Infinity
    );
    const adjustment = minLevel - 1;

    filtered.forEach((heading) => {
      const item = document.createElement('li');
      item.className = 'toc-item';
      item.setAttribute('data-level', String(heading.level - adjustment));
      item.setAttribute('data-pos', String(heading.pos));
      item.textContent = heading.text || '(empty)';
      item.title = heading.text;

      item.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.sourceClickHandler) {
          // Lock active heading to clicked one (same as scrollToHeading does for WYSIWYG)
          this.clickedPos = heading.pos;
          this.programmaticScroll = true;
          setTimeout(() => { this.programmaticScroll = false; }, 600);
          this.activeIndex = heading.pos;
          this.applyActiveClass(heading.pos);
          this.sourceClickHandler({ level: heading.level, text: heading.text });
        } else {
          this.scrollToHeading(heading.pos);
        }
      });

      this.tocList!.appendChild(item);
    });

    this.highlightActiveHeading();
  }

  // ─── Active Heading Detection ────────────────────────────────────────

  /**
   * Determine active heading based on scroll position.
   * Copied from Outline Contents.tsx:
   *   for each heading, get bounding rect
   *   if bounding.top > HEADING_OFFSET → break
   *   else → activeId = heading.id
   */
  private highlightActiveHeading(): void {
    if (!this.tocList || this.headings.length === 0) return;

    // If user recently clicked a TOC item, respect their choice
    if (this.clickedPos !== null) {
      const activePos = this.clickedPos;
      if (activePos === this.activeIndex) return;
      this.activeIndex = activePos;
      this.applyActiveClass(activePos);
      return;
    }

    // Source mode: use external provider for active heading
    if (this.sourceGetActivePos) {
      const activePos = this.sourceGetActivePos();
      if (activePos === this.activeIndex) return;
      this.activeIndex = activePos;
      this.applyActiveClass(activePos);
      return;
    }

    if (!this.scrollAreaEl) return;

    const scrollEl = this.scrollAreaEl!;
    const remainingScroll = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;

    // Determine active heading from ALL headings (not filtered)
    let activePos = -1;
    let lastVisiblePos = -1;

    for (let i = 0; i < this.headings.length; i++) {
      try {
        const pos = this.headings[i].pos + 1; // +1 to get inside heading
        const domPos = this.view.domAtPos(pos);
        if (!domPos || !domPos.node) continue;

        const el = domPos.node instanceof HTMLElement
          ? domPos.node
          : domPos.node.parentElement;

        if (!el) continue;

        const bounding = el.getBoundingClientRect();
        const scrollAreaRect = scrollEl.getBoundingClientRect();
        const relativeTop = bounding.top - scrollAreaRect.top;

        // Track the last heading visible within the viewport
        if (bounding.top < scrollAreaRect.bottom && bounding.bottom > scrollAreaRect.top) {
          lastVisiblePos = this.headings[i].pos;
        }

        if (relativeTop > HEADING_OFFSET) {
          break;
        }
        activePos = this.headings[i].pos;
      } catch {
        // Position might be invalid
      }
    }

    // When near the bottom (can't scroll a full viewport further), use last visible heading
    if (remainingScroll < scrollEl.clientHeight * 0.5 && lastVisiblePos !== -1) {
      activePos = lastVisiblePos;
    }

    if (activePos === this.activeIndex) return;
    this.activeIndex = activePos;
    this.applyActiveClass(activePos);
  }

  private applyActiveClass(activePos: number): void {
    if (!this.tocList) return;

    // Update active class on TOC items (match by data-pos)
    const items = this.tocList.querySelectorAll('.toc-item');
    let activeItem: HTMLElement | null = null;
    items.forEach((item) => {
      const itemPos = parseInt(item.getAttribute('data-pos') || '-1', 10);
      const isActive = itemPos === activePos;
      item.classList.toggle('active', isActive);
      if (isActive) activeItem = item as HTMLElement;
    });

    // Auto-scroll active item into view within TOC sidebar (Outline does this)
    if (activeItem) {
      activeItem.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      });
    }
  }

  // ─── Scroll to Heading ───────────────────────────────────────────────

  private scrollToHeading(pos: number): void {
    this.view.focus();

    // Lock active heading to the clicked one until next manual scroll
    this.clickedPos = pos;
    this.programmaticScroll = true;
    // After smooth scroll animation finishes, start listening for manual scroll
    setTimeout(() => { this.programmaticScroll = false; }, 600);

    // Immediately show clicked heading as active
    this.activeIndex = pos;
    this.applyActiveClass(pos);

    try {
      const resolvedPos = this.view.state.doc.resolve(pos + 1);
      const tr = this.view.state.tr.setSelection(
        TextSelection.create(this.view.state.doc, resolvedPos.pos)
      );
      tr.scrollIntoView();
      this.view.dispatch(tr);

      // DOM-level smooth scroll for precise positioning
      setTimeout(() => {
        try {
          const domPos = this.view.domAtPos(pos + 1);
          if (domPos && domPos.node) {
            const el = domPos.node instanceof HTMLElement
              ? domPos.node
              : domPos.node.parentElement;
            if (el) {
              scrollIntoView(el, {
                scrollMode: 'always',
                block: 'start',
                behavior: 'smooth',
              });
            }
          }
        } catch {
          // Fallback: ProseMirror scrollIntoView already handled it
        }
      }, 50);
    } catch {
      // Invalid position
    }
  }

  // ─── Scroll Listener ─────────────────────────────────────────────────

  /**
   * Throttled scroll listener (Outline: 100ms throttle)
   */
  private attachScrollListener(): void {
    if (!this.scrollAreaEl) return;

    this.scrollHandler = () => {
      if (!this.isVisible) return;

      // Manual scroll detected — unlock click lock
      if (this.clickedPos !== null && !this.programmaticScroll) {
        this.clickedPos = null;
      }

      if (this.throttleTimer) return;
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.highlightActiveHeading();
      }, 100);
    };

    this.scrollAreaEl.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  // ─── Comparison ──────────────────────────────────────────────────────

  private headingsChanged(a: HeadingEntry[], b: HeadingEntry[]): boolean {
    if (a.length !== b.length) return true;
    for (let i = 0; i < a.length; i++) {
      if (a[i].level !== b[i].level ||
          a[i].text !== b[i].text ||
          a[i].pos !== b[i].pos) {
        return true;
      }
    }
    return false;
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Called from dispatchTransaction on every state change */
  public update(view: EditorView): void {
    this.view = view;
    if (!this.isVisible) return;

    const newHeadings = this.extractHeadings(view.state.doc);

    if (this.headingsChanged(this.headings, newHeadings)) {
      this.headings = newHeadings;
      this.renderList();
    } else {
      this.highlightActiveHeading();
    }
  }

  public toggle(): void {
    if (this.isVisible) {
      this.close();
    } else {
      this.open();
    }
  }

  public open(): void {
    if (this.isVisible) return;
    this.isVisible = true;
    this.sidebar?.classList.remove('hidden');
    document.body.classList.add('toc-visible');

    // Reset filter
    this.filterText = '';
    if (this.filterInput) this.filterInput.value = '';

    this.headings = this.extractHeadings(this.view.state.doc);
    this.activeIndex = -1;
    this.renderList();
  }

  public close(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.sidebar?.classList.add('hidden');
    document.body.classList.remove('toc-visible');
  }

  /**
   * Enter source mode: listen to CodeMirror scroll and use callback for active heading.
   * @param getActivePos Returns the ProseMirror pos of the currently active heading, or -1.
   * @param scrollEl The CodeMirror scroll DOM element (.cm-scroller).
   */
  public enterSourceMode(getActivePos: () => number, scrollEl: HTMLElement): void {
    this.sourceGetActivePos = getActivePos;
    this.sourceScrollEl = scrollEl;

    this.sourceScrollHandler = () => {
      if (!this.isVisible) return;

      if (this.clickedPos !== null && !this.programmaticScroll) {
        this.clickedPos = null;
      }

      if (this.throttleTimer) return;
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.highlightActiveHeading();
      }, 100);
    };

    scrollEl.addEventListener('scroll', this.sourceScrollHandler, { passive: true });
    this.highlightActiveHeading();
  }

  public exitSourceMode(): void {
    if (this.sourceScrollHandler && this.sourceScrollEl) {
      this.sourceScrollEl.removeEventListener('scroll', this.sourceScrollHandler);
    }
    this.sourceScrollEl = null;
    this.sourceScrollHandler = null;
    this.sourceGetActivePos = null;
  }

  public get visible(): boolean {
    return this.isVisible;
  }

  public destroy(): void {
    this.exitSourceMode();
    if (this.scrollHandler && this.scrollAreaEl) {
      this.scrollAreaEl.removeEventListener('scroll', this.scrollHandler);
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
    }
    this.sidebar?.remove();
  }
}
