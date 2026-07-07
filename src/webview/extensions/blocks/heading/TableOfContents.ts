/**
 * Table of Contents Sidebar
 *
 * Displays headings (h1-h5) from the ProseMirror document.
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

type TocDropPlacement = 'before' | 'after';

function getHeadingSectionEnd(doc: ProsemirrorNode, headingPos: number, level: number): number {
  const headingNode = doc.nodeAt(headingPos);
  if (!headingNode) return headingPos;

  let sectionEnd = headingPos + headingNode.nodeSize;
  let foundBoundary = false;
  doc.forEach((node, offset) => {
    if (foundBoundary || offset <= headingPos) return;
    if (node.type.name === 'heading' && Number(node.attrs.level) <= level) {
      foundBoundary = true;
      return;
    }
    sectionEnd = offset + node.nodeSize;
  });
  return sectionEnd;
}

export class TableOfContents {
  private view: EditorView;
  private sidebar: HTMLElement | null = null;
  private tocList: HTMLElement | null = null;
  private statusBar: HTMLElement | null = null;
  private statusTotalChars: HTMLElement | null = null;
  private statusLine: HTMLElement | null = null;
  private statusSelectedChars: HTMLElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private levelButtons: Array<{ level: number; el: HTMLButtonElement }> = [];
  private levelToggleBtn: HTMLButtonElement | null = null;
  private maxVisibleLevel: number | null = null; // null = show all levels
  private collapsedHeadingPos = new Set<number>();
  private expandedHeadingPos = new Set<number>();
  private headings: HeadingEntry[] = [];
  private filterText = '';
  private isVisible = false;
  private activeIndex = -1;
  private scrollAreaEl: HTMLElement | null = null;
  private scrollHandler: (() => void) | null = null;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private clickedPos: number | null = null;
  private programmaticScroll = false;
  private draggedHeadingPos: number | null = null;
  private dragOverHeadingPos: number | null = null;
  private dragPlacement: TocDropPlacement | null = null;
  public sourceClickHandler: ((heading: { level: number; text: string }) => void) | null = null;
  private sourceScrollEl: HTMLElement | null = null;
  private sourceScrollHandler: (() => void) | null = null;
  private sourceGetActivePos: (() => number) | null = null;
  private visibleHeadingPosSet = new Set<number>();

  constructor(view: EditorView) {
    this.view = view;
    this.scrollAreaEl = document.getElementById('editor-scroll-area');
    this.ensureStyles();
    this.createSidebar();
    this.attachScrollListener();
  }

  private ensureStyles(): void {
    if (document.getElementById('easyview-toc-tree-styles')) return;
    const style = document.createElement('style');
    style.id = 'easyview-toc-tree-styles';
    style.textContent = `
      .toc-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        padding: 2px 6px;
        border-radius: 8px;
        transition: background 120ms ease, color 120ms ease;
      }
      .toc-item.active {
        border-left: none !important;
        box-shadow: none !important;
      }
      .toc-item.active::before {
        content: '';
        position: absolute;
        left: 0;
        top: 4px;
        bottom: 4px;
        width: 2px;
        border-radius: 999px;
        background: var(--mdpre-accent, var(--vscode-textLink-foreground, #4080d0));
      }
      .toc-item.drop-before {
        box-shadow: inset 0 2px 0 var(--mdpre-accent, var(--vscode-focusBorder, #409eff));
      }
      .toc-item.drop-after {
        box-shadow: inset 0 -2px 0 var(--mdpre-accent, var(--vscode-focusBorder, #409eff));
      }
      .toc-item.dragging {
        opacity: 0.45;
      }
      .toc-item-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }
      .toc-item-actions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .toc-item:hover .toc-item-actions,
      .toc-item.active .toc-item-actions {
        opacity: 1;
      }
      .toc-item-action {
        width: 20px;
        height: 20px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--vscode-descriptionForeground, var(--vscode-editor-foreground));
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
      }
      .toc-item-action:hover:not(:disabled) {
        background: color-mix(in srgb, var(--mdpre-accent, var(--vscode-focusBorder, #409eff)) 14%, transparent);
        color: var(--mdpre-accent, var(--vscode-focusBorder, #409eff));
      }
      .toc-item-action:disabled {
        opacity: 0.35;
        cursor: not-allowed;
      }
      .toc-item-drag-handle {
        cursor: grab;
      }
      .toc-item-drag-handle:active {
        cursor: grabbing;
      }
      .toc-item-delete svg,
      .toc-item-drag-handle svg {
        width: 13px;
        height: 13px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── DOM Creation ────────────────────────────────────────────────────

  private createSidebar(): void {
    this.sidebar = document.createElement('div');
    this.sidebar.className = 'toc-sidebar hidden';

    // Top controls: show heading levels H1 through H5.
    const controls = document.createElement('div');
    controls.className = 'toc-level-controls';
    this.levelToggleBtn = document.createElement('button');
    this.levelToggleBtn.className = 'toc-level-btn toc-level-toggle-btn active';
    this.levelToggleBtn.addEventListener('click', () => {
      // Toggle between "show all" and "collapsed to H1".
      if (this.maxVisibleLevel === null) {
        this.maxVisibleLevel = 1;
      } else {
        this.maxVisibleLevel = null;
      }
      this.refreshLevelControls();
      this.renderList();
    });
    controls.appendChild(this.levelToggleBtn);

    const levelOptions: Array<{ level: number; label: string; title: string }> = [
      { level: 1, label: 'H1', title: 'Show level 1 headings only' },
      { level: 2, label: 'H2', title: 'Show level 1-2 headings' },
      { level: 3, label: 'H3', title: 'Show level 1-3 headings' },
      { level: 4, label: 'H4', title: 'Show level 1-4 headings' },
      { level: 5, label: 'H5', title: 'Show level 1-5 headings' },
    ];
    levelOptions.forEach((option) => {
      const btn = document.createElement('button');
      btn.className = 'toc-level-btn';
      if (option.level === this.maxVisibleLevel) {
        btn.classList.add('active');
      }
      btn.textContent = option.label;
      btn.title = option.title;
      btn.addEventListener('click', () => {
        // Click same level again => cancel level filter (show all).
        this.maxVisibleLevel = this.maxVisibleLevel === option.level ? null : option.level;
        this.refreshLevelControls();
        this.renderList();
      });
      controls.appendChild(btn);
      this.levelButtons.push({ level: option.level, el: btn });
    });
    this.sidebar.appendChild(controls);
    this.refreshLevelControls();

    // List
    this.tocList = document.createElement('ul');
    this.tocList.className = 'toc-list';
    this.sidebar.appendChild(this.tocList);

    this.statusBar = document.createElement('div');
    this.statusBar.className = 'toc-status-bar';

    this.statusTotalChars = document.createElement('span');
    this.statusTotalChars.className = 'toc-status-item';
    this.statusBar.appendChild(this.statusTotalChars);

    this.statusLine = document.createElement('span');
    this.statusLine.className = 'toc-status-item';
    this.statusBar.appendChild(this.statusLine);

    this.statusSelectedChars = document.createElement('span');
    this.statusSelectedChars.className = 'toc-status-item';
    this.statusBar.appendChild(this.statusSelectedChars);

    this.sidebar.appendChild(this.statusBar);
    this.setStatus({
      totalChars: 0,
      line: 1,
      selectedChars: 0,
    });

    // Insert into #editor-body before #editor-scroll-area
    const editorBody = document.getElementById('editor-body');
    if (editorBody && this.scrollAreaEl) {
      editorBody.insertBefore(this.sidebar, this.scrollAreaEl);
    }
  }

  // ─── Heading Extraction ──────────────────────────────────────────────

  /**
   * Extract headings from document root level (level 1-5 only).
   * Based on Outline's ProsemirrorHelper.getHeadings()
   */
  private extractHeadings(doc: ProsemirrorNode): HeadingEntry[] {
    const headings: HeadingEntry[] = [];

    doc.forEach((node, offset) => {
      if (node.type.name === 'heading' && node.attrs.level <= 5) {
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

    const headingPosSet = new Set(this.headings.map((h) => h.pos));
    // Drop stale state for headings no longer present.
    this.collapsedHeadingPos.forEach((pos) => {
      if (!headingPosSet.has(pos)) this.collapsedHeadingPos.delete(pos);
    });
    this.expandedHeadingPos.forEach((pos) => {
      if (!headingPosSet.has(pos)) this.expandedHeadingPos.delete(pos);
    });

    const visibleByTree = this.computeVisibleHeadings();
    this.visibleHeadingPosSet = new Set(visibleByTree.map((h) => h.pos));
    // Filter headings by search text
    const filtered = this.filterText
      ? visibleByTree.filter((h) => h.text.toLowerCase().includes(this.filterText))
      : visibleByTree;

    if (filtered.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'toc-empty';
      empty.textContent = this.filterText ? 'No matches' : 'No headings found';
      this.tocList.appendChild(empty);
      return;
    }

    // Outline: normalize heading levels (min becomes 1)
    const minLevel = filtered.reduce(
      (min, h) => (h.level < min ? h.level : min),
      Infinity
    );
    const adjustment = minLevel - 1;

    const hasChildrenMap = new Map<number, boolean>();
    const hasChildrenBeyondMaxMap = new Map<number, boolean>();
    // Child existence is computed from the full extracted heading tree, not current level filter,
    // so H1/H2 still show toggle buttons even when their children are currently hidden by H1/H2 mode.
    for (let i = 0; i < this.headings.length; i++) {
      const current = this.headings[i];
      let hasChildren = false;
      let hasChildrenBeyondMax = false;
      for (let j = i + 1; j < this.headings.length; j++) {
        const next = this.headings[j];
        if (next.level <= current.level) break;
        hasChildren = true;
        if (this.maxVisibleLevel !== null && next.level > this.maxVisibleLevel) {
          hasChildrenBeyondMax = true;
          // Found at least one descendant hidden by level mode; no need to keep scanning.
          break;
        }
      }
      hasChildrenMap.set(current.pos, hasChildren);
      hasChildrenBeyondMaxMap.set(current.pos, hasChildrenBeyondMax);
    }

    filtered.forEach((heading) => {
      const actionsDisabled = !!this.sourceClickHandler;
      const hasChildren = hasChildrenMap.get(heading.pos) ?? false;
      const hasChildrenBeyondMax = hasChildrenBeyondMaxMap.get(heading.pos) ?? false;

      const item = document.createElement('li');
      item.className = 'toc-item';
      item.setAttribute('data-level', String(heading.level - adjustment));
      item.setAttribute('data-pos', String(heading.pos));
      item.title = heading.text;

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'toc-item-toggle';
      if (!hasChildren) {
        toggleBtn.classList.add('empty');
        toggleBtn.disabled = true;
        toggleBtn.textContent = '';
        toggleBtn.title = 'No child headings';
      } else {
        const explicitCollapsed = this.collapsedHeadingPos.has(heading.pos);
        const levelCollapsed = this.maxVisibleLevel !== null
          && hasChildrenBeyondMax
          && !this.expandedHeadingPos.has(heading.pos);
        const isCollapsed = explicitCollapsed || levelCollapsed;
        toggleBtn.textContent = isCollapsed ? '▸' : '▾';
        toggleBtn.title = isCollapsed ? 'Expand children' : 'Collapse children';
        toggleBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const explicitCollapsedNow = this.collapsedHeadingPos.has(heading.pos);
          const expandedOverrideNow = this.expandedHeadingPos.has(heading.pos);
          const levelCollapsedNow = this.maxVisibleLevel !== null
            && hasChildrenBeyondMax
            && !expandedOverrideNow;

          if (explicitCollapsedNow) {
            this.collapsedHeadingPos.delete(heading.pos);
          } else if (levelCollapsedNow) {
            this.expandedHeadingPos.add(heading.pos);
            this.collapsedHeadingPos.delete(heading.pos);
          } else if (expandedOverrideNow) {
            this.expandedHeadingPos.delete(heading.pos);
          } else {
            this.collapsedHeadingPos.add(heading.pos);
            this.expandedHeadingPos.delete(heading.pos);
          }
          this.renderList();
        });
      }

      const text = document.createElement('span');
      text.className = 'toc-item-text';
      text.textContent = heading.text || '(empty)';
      text.title = heading.text;

      const actions = document.createElement('span');
      actions.className = 'toc-item-actions';

      const dragBtn = document.createElement('button');
      dragBtn.type = 'button';
      dragBtn.className = 'toc-item-action toc-item-drag-handle';
      dragBtn.title = actionsDisabled ? 'Move is available in EasyView mode only' : 'Drag to move this heading section';
      dragBtn.draggable = !actionsDisabled;
      dragBtn.disabled = actionsDisabled;
      dragBtn.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.25"/><circle cx="15" cy="6" r="1.25"/><circle cx="9" cy="12" r="1.25"/><circle cx="15" cy="12" r="1.25"/><circle cx="9" cy="18" r="1.25"/><circle cx="15" cy="18" r="1.25"/></svg>';
      dragBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      dragBtn.addEventListener('dragstart', (event) => {
        if (actionsDisabled) {
          event.preventDefault();
          return;
        }
        this.draggedHeadingPos = heading.pos;
        item.classList.add('dragging');
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(heading.pos));
        }
      });
      dragBtn.addEventListener('dragend', () => {
        this.clearDropIndicators();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'toc-item-action toc-item-delete';
      deleteBtn.title = actionsDisabled ? 'Delete is available in EasyView mode only' : 'Delete this heading and its content';
      deleteBtn.disabled = actionsDisabled;
      deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
      deleteBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (actionsDisabled) return;
        this.deleteHeadingSection(heading.pos);
      });

      actions.appendChild(dragBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(toggleBtn);
      item.appendChild(text);
      item.appendChild(actions);

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

      if (!actionsDisabled) {
        item.addEventListener('dragover', (event) => {
          if (this.draggedHeadingPos === null || this.draggedHeadingPos === heading.pos) return;
          event.preventDefault();
          const rect = item.getBoundingClientRect();
          const placement: TocDropPlacement = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
          this.setDropIndicator(heading.pos, placement);
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
          }
        });

        item.addEventListener('dragleave', (event) => {
          const related = event.relatedTarget as Node | null;
          if (related && item.contains(related)) return;
          if (this.dragOverHeadingPos === heading.pos) {
            this.clearDropIndicators();
          }
        });

        item.addEventListener('drop', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const sourcePos = this.draggedHeadingPos;
          const placement = this.dragPlacement;
          this.clearDropIndicators();
          if (sourcePos === null || placement === null || sourcePos === heading.pos) return;
          this.moveHeadingSection(sourcePos, heading.pos, placement);
        });
      }

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
      const activePos = this.findVisibleAncestorPos(this.sourceGetActivePos());
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

    activePos = this.findVisibleAncestorPos(activePos);
    if (activePos === this.activeIndex) return;
    this.activeIndex = activePos;
    this.applyActiveClass(activePos);
  }

  private findVisibleAncestorPos(pos: number): number {
    if (pos < 0 || this.headings.length === 0) return -1;
    let candidate = -1;
    for (const heading of this.headings) {
      if (heading.pos > pos) break;
      if (this.visibleHeadingPosSet.has(heading.pos)) {
        candidate = heading.pos;
      }
    }
    return candidate;
  }

  private clearDropIndicators(): void {
    this.draggedHeadingPos = null;
    this.dragOverHeadingPos = null;
    this.dragPlacement = null;
    this.tocList?.querySelectorAll('.toc-item.dragging, .toc-item.drop-before, .toc-item.drop-after').forEach((el) => {
      el.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  }

  private setDropIndicator(targetPos: number, placement: TocDropPlacement): void {
    this.dragOverHeadingPos = targetPos;
    this.dragPlacement = placement;
    this.tocList?.querySelectorAll('.toc-item').forEach((el) => {
      const pos = Number((el as HTMLElement).dataset.pos ?? '-1');
      el.classList.toggle('drop-before', pos === targetPos && placement === 'before');
      el.classList.toggle('drop-after', pos === targetPos && placement === 'after');
    });
  }

  private deleteHeadingSection(headingPos: number): void {
    const heading = this.headings.find((entry) => entry.pos === headingPos);
    if (!heading) return;
    const to = getHeadingSectionEnd(this.view.state.doc, heading.pos, heading.level);
    if (to <= heading.pos) return;

    const tr = this.view.state.tr.delete(heading.pos, to).scrollIntoView();
    this.collapsedHeadingPos.delete(heading.pos);
    this.expandedHeadingPos.delete(heading.pos);
    this.clickedPos = null;
    this.view.dispatch(tr);
    this.view.focus();
  }

  private moveHeadingSection(sourcePos: number, targetPos: number, placement: TocDropPlacement): void {
    const sourceHeading = this.headings.find((entry) => entry.pos === sourcePos);
    const targetHeading = this.headings.find((entry) => entry.pos === targetPos);
    if (!sourceHeading || !targetHeading) return;

    const doc = this.view.state.doc;
    const dragFrom = sourceHeading.pos;
    const dragTo = getHeadingSectionEnd(doc, sourceHeading.pos, sourceHeading.level);
    if (dragTo <= dragFrom) return;

    const dropPos = placement === 'before'
      ? targetHeading.pos
      : getHeadingSectionEnd(doc, targetHeading.pos, targetHeading.level);

    if (dropPos >= dragFrom && dropPos <= dragTo) return;

    const slice = doc.slice(dragFrom, dragTo);
    let tr = this.view.state.tr;
    let nextHeadingPos = placement === 'before' ? targetHeading.pos : getHeadingSectionEnd(doc, targetHeading.pos, targetHeading.level);

    if (dropPos <= dragFrom) {
      tr = tr.replaceRange(dropPos, dropPos, slice);
      nextHeadingPos = dropPos;
      tr = tr.delete(tr.mapping.map(dragFrom), tr.mapping.map(dragTo));
    } else {
      tr = tr.delete(dragFrom, dragTo);
      const mappedDropPos = tr.mapping.map(dropPos);
      nextHeadingPos = mappedDropPos;
      tr = tr.replaceRange(mappedDropPos, mappedDropPos, slice);
    }

    this.clickedPos = nextHeadingPos;
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
  }

  private computeVisibleHeadings(): HeadingEntry[] {
    if (this.headings.length === 0) return [];
    const result: HeadingEntry[] = [];
    const collapsedStack: Array<{ level: number; pos: number }> = [];
    const expandedStack: Array<{ level: number; pos: number }> = [];
    const maxVisible = this.maxVisibleLevel ?? Number.POSITIVE_INFINITY;

    for (const heading of this.headings) {
      while (collapsedStack.length > 0 && heading.level <= collapsedStack[collapsedStack.length - 1].level) {
        collapsedStack.pop();
      }
      while (expandedStack.length > 0 && heading.level <= expandedStack[expandedStack.length - 1].level) {
        expandedStack.pop();
      }

      const hiddenByCollapse = collapsedStack.length > 0;
      const expandedByAncestor = expandedStack.length > 0;
      const visibleByLevel = heading.level <= maxVisible || expandedByAncestor;

      if (!hiddenByCollapse && visibleByLevel) {
        result.push(heading);
      }

      if (this.collapsedHeadingPos.has(heading.pos)) {
        collapsedStack.push({ level: heading.level, pos: heading.pos });
      }
      if (this.expandedHeadingPos.has(heading.pos)) {
        expandedStack.push({ level: heading.level, pos: heading.pos });
      }
    }

    return result;
  }

  private refreshLevelControls(): void {
    if (this.levelToggleBtn) {
      const isAll = this.maxVisibleLevel === null;
      this.levelToggleBtn.textContent = isAll ? '▾' : '▸';
      this.levelToggleBtn.title = isAll
        ? 'Collapse to level 1'
        : 'Expand all levels';
      this.levelToggleBtn.classList.toggle('active', isAll);
    }
    this.levelButtons.forEach((entry) => {
      entry.el.classList.toggle('active', this.maxVisibleLevel === entry.level);
    });
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

  private findActiveHeadingPosBySelectionPos(selectionPos: number): number {
    if (this.headings.length === 0) return -1;
    let candidate = -1;
    for (const heading of this.headings) {
      if (heading.pos > selectionPos) break;
      candidate = heading.pos;
    }
    return this.findVisibleAncestorPos(candidate);
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
  public update(view: EditorView, transaction?: { docChanged?: boolean; selectionSet?: boolean }): void {
    this.view = view;
    if (!this.isVisible) return;

    const newHeadings = this.extractHeadings(view.state.doc);

    if (this.headingsChanged(this.headings, newHeadings)) {
      this.headings = newHeadings;
      this.renderList();
      return;
    }

    // Fast path for large documents: when only cursor/selection moves,
    // compute active heading from document position instead of scanning DOM.
    if (transaction?.selectionSet || transaction?.docChanged) {
      const activePos = this.findActiveHeadingPosBySelectionPos(view.state.selection.from);
      if (activePos !== this.activeIndex) {
        this.activeIndex = activePos;
        this.applyActiveClass(activePos);
      }
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
    if (this.isVisible) this.renderList();
    this.highlightActiveHeading();
  }

  public exitSourceMode(): void {
    if (this.sourceScrollHandler && this.sourceScrollEl) {
      this.sourceScrollEl.removeEventListener('scroll', this.sourceScrollHandler);
    }
    this.sourceScrollEl = null;
    this.sourceScrollHandler = null;
    this.sourceGetActivePos = null;
    if (this.isVisible) this.renderList();
  }

  public get visible(): boolean {
    return this.isVisible;
  }

  public setStatus(stats: { totalChars: number; line: number; selectedChars: number }): void {
    if (!this.statusTotalChars || !this.statusLine || !this.statusSelectedChars) return;
    const totalChars = Math.max(0, Number.isFinite(stats.totalChars) ? Math.floor(stats.totalChars) : 0);
    const line = Math.max(1, Number.isFinite(stats.line) ? Math.floor(stats.line) : 1);
    const selectedChars = Math.max(0, Number.isFinite(stats.selectedChars) ? Math.floor(stats.selectedChars) : 0);
    this.statusTotalChars.textContent = `Chars ${totalChars}`;
    this.statusLine.textContent = `Ln ${line}`;
    this.statusSelectedChars.textContent = `Sel ${selectedChars}`;
  }

  public destroy(): void {
    this.exitSourceMode();
    this.clearDropIndicators();
    if (this.scrollHandler && this.scrollAreaEl) {
      this.scrollAreaEl.removeEventListener('scroll', this.scrollHandler);
    }
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
    }
    this.sidebar?.remove();
  }
}
