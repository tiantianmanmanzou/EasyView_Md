/**
 * Table of Contents Sidebar
 *
 * Displays headings (h1-h5) from the ProseMirror document.
 * Click to scroll, active heading highlight on scroll.
 * Based on Outline's Contents.tsx component.
 */

import type { EditorView } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';
import { createEditorDomContext, type EditorDomContext } from '../../../runtime/editorDomContext';
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

interface TocExpandState {
  collapsedHeadingKeys: string[];
  expandedHeadingKeys: string[];
  collapsedTablePathKeys: string[];
  expandedTablePathKeys: string[];
  maxVisibleLevel: number | null;
}

const TOC_EXPAND_KEY_PREFIX = 'easyview-toc-expand:';
const TOC_PATH_SEP = '\u0001';

/** Stable outline key: ancestor `level:text` chain with sibling-occurrence disambiguation. */
function buildHeadingPosToKey(headings: HeadingEntry[]): Map<number, string> {
  const posToKey = new Map<number, string>();
  const stack: Array<{ level: number; key: string }> = [];
  const siblingCounts = new Map<string, number>();

  for (const heading of headings) {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    const parentKey = stack.length > 0 ? stack[stack.length - 1].key : '';
    const segment = `${heading.level}:${heading.text}`;
    const countKey = parentKey ? `${parentKey}${TOC_PATH_SEP}${segment}` : segment;
    const occurrence = siblingCounts.get(countKey) ?? 0;
    siblingCounts.set(countKey, occurrence + 1);
    const disambiguated = occurrence === 0 ? segment : `${segment}#${occurrence}`;
    const key = parentKey ? `${parentKey}${TOC_PATH_SEP}${disambiguated}` : disambiguated;
    posToKey.set(heading.pos, key);
    stack.push({ level: heading.level, key });
  }
  return posToKey;
}

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
  private tableModeToggleBtn: HTMLButtonElement | null = null;
  private tableMode: boolean;
  private maxVisibleLevel: number | null = null; // null = show all levels
  private collapsedHeadingKeys = new Set<string>();
  private expandedHeadingKeys = new Set<string>();
  private headingPosToKey = new Map<number, string>();
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
  private tableTreeRows: Array<{ path: string[]; row: HTMLTableRowElement }> = [];
  private activeTablePathKey: string | null = null;
  private clickedTablePathKey: string | null = null;
  private collapsedTablePathKeys = new Set<string>();
  private expandedTablePathKeys = new Set<string>();
  private sidebarWidth: number;
  private resizer: HTMLElement | null = null;
  private isResizingSidebar = false;
  private currentFilePath = '';

  private loadTableMode(): boolean {
    try {
      const saved = this.dom.window.localStorage.getItem('easyview-toc-mode');
      return saved === null ? true : saved === 'table';
    } catch {
      return true;
    }
  }

  private saveTableMode(): void {
    try {
      this.dom.window.localStorage.setItem('easyview-toc-mode', this.tableMode ? 'table' : 'normal');
    } catch {
      // Webview storage can be unavailable in restricted environments.
    }
  }

  private static readonly TOC_WIDTH_MIN = 180;
  private static readonly TOC_WIDTH_MAX = 560;
  private static readonly TOC_WIDTH_DEFAULT = 256;

  private loadSidebarWidth(): number {
    try {
      const saved = Number(this.dom.window.localStorage.getItem('easyview-toc-width'));
      if (Number.isFinite(saved) && saved >= TableOfContents.TOC_WIDTH_MIN && saved <= TableOfContents.TOC_WIDTH_MAX) {
        return Math.round(saved);
      }
    } catch {
      // Webview storage can be unavailable in restricted environments.
    }
    return TableOfContents.TOC_WIDTH_DEFAULT;
  }

  private saveSidebarWidth(): void {
    try {
      this.dom.window.localStorage.setItem('easyview-toc-width', String(this.sidebarWidth));
    } catch {
      // Webview storage can be unavailable in restricted environments.
    }
  }

  private expandStorageKey(filePath = this.currentFilePath): string {
    return `${TOC_EXPAND_KEY_PREFIX}${filePath}`;
  }

  private clearExpandStateInMemory(): void {
    this.collapsedHeadingKeys.clear();
    this.expandedHeadingKeys.clear();
    this.collapsedTablePathKeys.clear();
    this.expandedTablePathKeys.clear();
    this.maxVisibleLevel = null;
  }

  private saveExpandState(): void {
    if (!this.currentFilePath) return;
    const payload: TocExpandState = {
      collapsedHeadingKeys: [...this.collapsedHeadingKeys],
      expandedHeadingKeys: [...this.expandedHeadingKeys],
      collapsedTablePathKeys: [...this.collapsedTablePathKeys],
      expandedTablePathKeys: [...this.expandedTablePathKeys],
      maxVisibleLevel: this.maxVisibleLevel,
    };
    const isDefault =
      payload.collapsedHeadingKeys.length === 0
      && payload.expandedHeadingKeys.length === 0
      && payload.collapsedTablePathKeys.length === 0
      && payload.expandedTablePathKeys.length === 0
      && payload.maxVisibleLevel === null;
    try {
      if (isDefault) {
        this.dom.window.localStorage.removeItem(this.expandStorageKey());
      } else {
        this.dom.window.localStorage.setItem(this.expandStorageKey(), JSON.stringify(payload));
      }
    } catch {
      // Webview storage can be unavailable in restricted environments.
    }
  }

  private loadExpandState(): void {
    this.clearExpandStateInMemory();
    if (!this.currentFilePath) return;
    try {
      const raw = this.dom.window.localStorage.getItem(this.expandStorageKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<TocExpandState>;
      if (Array.isArray(parsed.collapsedHeadingKeys)) {
        parsed.collapsedHeadingKeys.forEach((key) => {
          if (typeof key === 'string') this.collapsedHeadingKeys.add(key);
        });
      }
      if (Array.isArray(parsed.expandedHeadingKeys)) {
        parsed.expandedHeadingKeys.forEach((key) => {
          if (typeof key === 'string') this.expandedHeadingKeys.add(key);
        });
      }
      if (Array.isArray(parsed.collapsedTablePathKeys)) {
        parsed.collapsedTablePathKeys.forEach((key) => {
          if (typeof key === 'string') this.collapsedTablePathKeys.add(key);
        });
      }
      if (Array.isArray(parsed.expandedTablePathKeys)) {
        parsed.expandedTablePathKeys.forEach((key) => {
          if (typeof key === 'string') this.expandedTablePathKeys.add(key);
        });
      }
      if (
        parsed.maxVisibleLevel === null
        || (typeof parsed.maxVisibleLevel === 'number'
          && Number.isInteger(parsed.maxVisibleLevel)
          && parsed.maxVisibleLevel >= 1
          && parsed.maxVisibleLevel <= 5)
      ) {
        this.maxVisibleLevel = parsed.maxVisibleLevel ?? null;
      }
    } catch {
      this.clearExpandStateInMemory();
    }
  }

  private rebuildHeadingKeyMap(): void {
    this.headingPosToKey = buildHeadingPosToKey(this.headings);
  }

  private headingKeyForPos(pos: number): string | null {
    return this.headingPosToKey.get(pos) ?? null;
  }

  private isHeadingCollapsed(pos: number): boolean {
    const key = this.headingKeyForPos(pos);
    return key !== null && this.collapsedHeadingKeys.has(key);
  }

  private isHeadingExpanded(pos: number): boolean {
    const key = this.headingKeyForPos(pos);
    return key !== null && this.expandedHeadingKeys.has(key);
  }

  private applySidebarWidth(width = this.sidebarWidth): void {
    this.sidebarWidth = Math.max(
      TableOfContents.TOC_WIDTH_MIN,
      Math.min(TableOfContents.TOC_WIDTH_MAX, Math.round(width)),
    );
    if (!this.sidebar || this.sidebar.classList.contains('hidden')) return;
    this.sidebar.style.width = `${this.sidebarWidth}px`;
    this.sidebar.style.minWidth = `${this.sidebarWidth}px`;
  }

  private readonly dom: EditorDomContext;

  constructor(view: EditorView, private readonly options: { position?: 'left' | 'right'; dom?: EditorDomContext } = {}) {
    this.view = view;
    this.dom = options.dom ?? createEditorDomContext();
    this.tableMode = this.loadTableMode();
    this.sidebarWidth = this.loadSidebarWidth();
    this.scrollAreaEl = this.dom.getById('editor-scroll-area');
    this.ensureStyles();
    this.createSidebar();
    this.attachScrollListener();
  }

  getHeadings(): Array<{ level: number; text: string; pos: number }> {
    return this.headings.map(({ level, text, pos }) => ({ level, text, pos }));
  }

  private ensureStyles(): void {
    if (this.dom.getById('easyview-toc-tree-styles')) return;
    const style = this.dom.document.createElement('style');
    style.id = 'easyview-toc-tree-styles';
    style.textContent = `
      .toc-sidebar {
        position: relative;
        transition:
          width 0.2s ease,
          min-width 0.2s ease,
          opacity 0.2s ease,
          padding 0.2s ease,
          border-color 0.2s ease;
      }

      .toc-sidebar.resizing {
        transition: none !important;
        user-select: none;
      }

      .toc-sidebar-resizer {
        position: absolute;
        top: 0;
        right: 0;
        width: 6px;
        height: 100%;
        cursor: col-resize;
        z-index: 6;
        touch-action: none;
      }
      .toc-sidebar-right .toc-sidebar-resizer { left: 0; right: auto; }

      .toc-sidebar-resizer::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: 2px;
        width: 2px;
        border-radius: 999px;
        background: transparent;
        transition: background 120ms ease;
      }

      .toc-sidebar-resizer:hover::after,
      .toc-sidebar.resizing .toc-sidebar-resizer::after {
        background: var(--mdpre-accent, var(--vscode-focusBorder, #409eff));
      }

      .toc-sidebar.hidden {
        width: 0 !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        opacity: 0;
        pointer-events: none;
        padding-left: 0 !important;
        padding-right: 0 !important;
        border-right-color: transparent !important;
        overflow: hidden;
      }

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
      .toc-item-level {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        min-width: 22px;
        height: 16px;
        padding: 0 5px;
        border-radius: 4px;
        border: 1px solid var(--vscode-editorWidget-border, rgba(128, 128, 128, .28));
        background: color-mix(in srgb, var(--vscode-editor-foreground) 6%, transparent);
        color: var(--vscode-descriptionForeground, #8a8a8a);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .02em;
        line-height: 1;
        pointer-events: none;
        user-select: none;
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
      .toc-table-controls { display:flex; align-items:center; justify-content:center; padding:8px 12px 10px; }
      .toc-table-mode-group { display:grid; grid-template-columns:1fr 1fr; width:min(100%, 224px); align-items:stretch; border:1px solid var(--vscode-input-border,rgba(128,128,128,.3)); border-radius:8px; overflow:hidden; background:var(--vscode-input-background,rgba(128,128,128,.12)); }
      .toc-table-mode-option { height:30px; min-width:0; padding:0 12px; border:0; border-right:1px solid var(--vscode-input-border,rgba(128,128,128,.3)); background:transparent; color:var(--vscode-editor-foreground,#ccc); cursor:pointer; font:inherit; font-size:12px; font-weight:600; }
      .toc-table-mode-option:last-child { border-right:0; }
      .toc-table-mode-option.active {
        background: var(--mdpre-accent, var(--vscode-button-background, #65aaf5));
        color: var(--vscode-button-foreground, #fff);
      }
      .toc-table-item {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 0 4px;
      }
      .toc-table-node {
        display: flex;
        align-items: center;
        gap: 4px;
        flex: 1;
        min-width: 0;
        padding: 4px 8px 4px 4px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--vscode-foreground, #ccc);
        text-align: left;
        cursor: pointer;
        font: inherit;
        transition: background 120ms ease, color 120ms ease;
      }
      .toc-table-node:hover {
        background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, .1));
      }
      .toc-table-node.active {
        background: var(--mdpre-accent-soft, var(--vscode-list-activeSelectionBackground, rgba(64, 128, 208, .14)));
        color: var(--mdpre-accent-text, var(--mdpre-accent, var(--vscode-list-activeSelectionForeground, var(--vscode-textLink-foreground, #4080d0))));
        font-weight: 600;
      }
      .toc-table-node.active .toc-table-node-count {
        color: inherit;
        opacity: 0.72;
      }
      .toc-table-node-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        flex-shrink: 0;
        margin-left: 4px;
        padding: 0;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--vscode-descriptionForeground, #888);
        cursor: pointer;
        font: inherit;
        font-size: 16px;
        line-height: 1;
      }
      .toc-table-node-toggle:hover:not(:disabled) {
        color: var(--mdpre-accent, var(--vscode-textLink-foreground, #4080d0));
        background: color-mix(in srgb, var(--mdpre-accent, var(--vscode-focusBorder, #409eff)) 14%, transparent);
      }
      .toc-table-node-toggle.empty {
        opacity: 0.35;
        cursor: default;
      }
      .toc-table-item[data-depth="1"] .toc-table-node-toggle { margin-left: 4px; }
      .toc-table-item[data-depth="2"] .toc-table-node-toggle { margin-left: 16px; }
      .toc-table-item[data-depth="3"] .toc-table-node-toggle { margin-left: 28px; }
      .toc-table-item[data-depth="4"] .toc-table-node-toggle { margin-left: 40px; }
      .toc-table-node-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; } .toc-table-node-count { color:var(--vscode-descriptionForeground,#888); font-size:10px; }
      .toc-table-empty { padding:16px 12px; color:var(--vscode-descriptionForeground,#888); font-size:12px; }
      .toc-table-row-match { outline:2px solid var(--mdpre-accent,var(--vscode-focusBorder,#409eff)); outline-offset:-2px; }
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
    this.dom.document.head.appendChild(style);
  }

  // ─── DOM Creation ────────────────────────────────────────────────────

  private createSidebar(): void {
    this.sidebar = this.dom.document.createElement('div');
    this.sidebar.className = `toc-sidebar hidden toc-sidebar-${this.options.position ?? 'left'}`;

    // Top controls: choose the outline data source.
    const tableControls = this.dom.document.createElement('div');
    tableControls.className = 'toc-table-controls';
    const modeGroup = this.dom.document.createElement('div');
    modeGroup.className = 'toc-table-mode-group';
    const detailModeBtn = this.dom.document.createElement('button');
    detailModeBtn.type = 'button';
    detailModeBtn.className = 'toc-table-mode-option';
    detailModeBtn.textContent = '全文目录';
    detailModeBtn.addEventListener('click', () => {
      this.tableMode = false;
      this.refreshTableModeControl();
      this.renderList();
    });
    this.tableModeToggleBtn = this.dom.document.createElement('button');
    this.tableModeToggleBtn.type = 'button';
    this.tableModeToggleBtn.className = 'toc-table-mode-option';
    this.tableModeToggleBtn.textContent = '表格目录';
    this.tableModeToggleBtn.addEventListener('click', () => {
      this.tableMode = true;
      this.refreshTableModeControl();
      this.renderList();
    });
    modeGroup.append(detailModeBtn, this.tableModeToggleBtn);
    tableControls.append(modeGroup);
    this.sidebar.appendChild(tableControls);
    this.refreshTableModeControl();

    const controls = this.dom.document.createElement('div');
    controls.className = 'toc-level-controls';
    this.levelToggleBtn = this.dom.document.createElement('button');
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
      this.saveExpandState();
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
      const btn = this.dom.document.createElement('button');
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
        this.saveExpandState();
      });
      controls.appendChild(btn);
      this.levelButtons.push({ level: option.level, el: btn });
    });
    this.sidebar.appendChild(controls);
    this.refreshLevelControls();

    // List
    this.tocList = this.dom.document.createElement('ul');
    this.tocList.className = 'toc-list';
    this.sidebar.appendChild(this.tocList);

    this.statusBar = this.dom.document.createElement('div');
    this.statusBar.className = 'toc-status-bar';

    this.statusTotalChars = this.dom.document.createElement('span');
    this.statusTotalChars.className = 'toc-status-item';
    this.statusBar.appendChild(this.statusTotalChars);

    this.statusLine = this.dom.document.createElement('span');
    this.statusLine.className = 'toc-status-item';
    this.statusBar.appendChild(this.statusLine);

    this.statusSelectedChars = this.dom.document.createElement('span');
    this.statusSelectedChars.className = 'toc-status-item';
    this.statusBar.appendChild(this.statusSelectedChars);

    this.sidebar.appendChild(this.statusBar);
    this.setStatus({
      totalChars: 0,
      line: 1,
      selectedChars: 0,
    });

    this.resizer = this.dom.document.createElement('div');
    this.resizer.className = 'toc-sidebar-resizer';
    this.resizer.title = 'Drag to resize outline';
    this.resizer.addEventListener('pointerdown', (event) => this.beginSidebarResize(event));
    this.sidebar.appendChild(this.resizer);
    this.applySidebarWidth();

    // Insert beside the editor scroll area in the configured host position.
    const editorBody = this.dom.getById('editor-body');
    if (editorBody && this.scrollAreaEl) {
      if (this.options.position === 'right') editorBody.appendChild(this.sidebar);
      else editorBody.insertBefore(this.sidebar, this.scrollAreaEl);
    }

    this.attachSidebarTransitionListener();
  }

  private beginSidebarResize(event: PointerEvent): void {
    if (!this.sidebar || !this.resizer || this.sidebar.classList.contains('hidden')) return;
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = this.sidebar.getBoundingClientRect().width;
    this.isResizingSidebar = true;
    this.sidebar.classList.add('resizing');
    this.resizer.setPointerCapture(event.pointerId);

    const onMove = (moveEvent: PointerEvent) => {
      const direction = this.options.position === 'right' ? -1 : 1;
      const nextWidth = startWidth + direction * (moveEvent.clientX - startX);
      this.applySidebarWidth(nextWidth);
      this.notifyLayoutChange();
    };

    const onUp = (upEvent: PointerEvent) => {
      this.isResizingSidebar = false;
      this.sidebar?.classList.remove('resizing');
      try {
        this.resizer?.releasePointerCapture(upEvent.pointerId);
      } catch {
        // Pointer may already be released by the browser.
      }
      this.resizer?.removeEventListener('pointermove', onMove);
      this.resizer?.removeEventListener('pointerup', onUp);
      this.resizer?.removeEventListener('pointercancel', onUp);
      this.saveSidebarWidth();
      this.dom.eventTarget.dispatchEvent(new CustomEvent('easyview-toc-width-change', { detail: this.sidebarWidth }));
      this.scheduleLayoutChangeNotifications();
    };

    this.resizer.addEventListener('pointermove', onMove);
    this.resizer.addEventListener('pointerup', onUp);
    this.resizer.addEventListener('pointercancel', onUp);
  }

  private notifyLayoutChange(): void {
    this.dom.eventTarget.dispatchEvent(new CustomEvent('easyview-toc-layout-change'));
  }

  private scheduleLayoutChangeNotifications(): void {
    const notify = () => this.notifyLayoutChange();
    notify();
    requestAnimationFrame(notify);
    setTimeout(notify, 60);
    setTimeout(notify, 220);
  }

  private attachSidebarTransitionListener(): void {
    if (!this.sidebar || this.sidebar.dataset.easyviewLayoutBound === '1') return;
    this.sidebar.dataset.easyviewLayoutBound = '1';
    this.sidebar.addEventListener('transitionend', (event) => {
      const property = event.propertyName;
      if (
        property === 'width' ||
        property === 'min-width' ||
        property === 'margin-left' ||
        property === 'padding-left' ||
        property === 'padding-right'
      ) {
        this.notifyLayoutChange();
      }
    });
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
    if (this.tableMode) {
      this.renderTableTree();
      return;
    }

    this.rebuildHeadingKeyMap();
    // Only prune after real headings exist. An empty tree (e.g. mid file-switch)
    // must not wipe freshly restored expand keys.
    if (this.headings.length > 0) {
      const headingKeySet = new Set(this.headingPosToKey.values());
      this.collapsedHeadingKeys.forEach((key) => {
        if (!headingKeySet.has(key)) this.collapsedHeadingKeys.delete(key);
      });
      this.expandedHeadingKeys.forEach((key) => {
        if (!headingKeySet.has(key)) this.expandedHeadingKeys.delete(key);
      });
    }

    const visibleByTree = this.computeVisibleHeadings();
    this.visibleHeadingPosSet = new Set(visibleByTree.map((h) => h.pos));
    // Filter headings by search text
    const filtered = this.filterText
      ? visibleByTree.filter((h) => h.text.toLowerCase().includes(this.filterText))
      : visibleByTree;

    if (filtered.length === 0) {
      const empty = this.dom.document.createElement('li');
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
      // The first deeper heading is the next-level child. Only that level is
      // revealed by expanding this node; deeper descendants belong to the
      // child node and must be expanded separately.
      for (let j = i + 1; j < this.headings.length; j++) {
        const next = this.headings[j];
        if (next.level <= current.level) break;
        hasChildren = true;
        hasChildrenBeyondMax = this.maxVisibleLevel !== null && next.level > this.maxVisibleLevel;
        break;
      }
      hasChildrenMap.set(current.pos, hasChildren);
      hasChildrenBeyondMaxMap.set(current.pos, hasChildrenBeyondMax);
    }

    filtered.forEach((heading) => {
      const actionsDisabled = !!this.sourceClickHandler;
      const hasChildren = hasChildrenMap.get(heading.pos) ?? false;
      const hasChildrenBeyondMax = hasChildrenBeyondMaxMap.get(heading.pos) ?? false;

      const item = this.dom.document.createElement('li');
      item.className = 'toc-item';
      item.setAttribute('data-level', String(heading.level - adjustment));
      item.setAttribute('data-pos', String(heading.pos));
      item.title = heading.text;

      const toggleBtn = this.dom.document.createElement('button');
      toggleBtn.className = 'toc-item-toggle';
      if (!hasChildren) {
        toggleBtn.classList.add('empty');
        toggleBtn.disabled = true;
        toggleBtn.textContent = '';
        toggleBtn.title = 'No child headings';
      } else {
        const explicitCollapsed = this.isHeadingCollapsed(heading.pos);
        const levelCollapsed = this.maxVisibleLevel !== null
          && hasChildrenBeyondMax
          && !this.isHeadingExpanded(heading.pos);
        const isCollapsed = explicitCollapsed || levelCollapsed;
        toggleBtn.textContent = isCollapsed ? '▸' : '▾';
        toggleBtn.title = isCollapsed ? 'Expand children' : 'Collapse children';
        toggleBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.toggleHeadingCollapse(heading.pos, hasChildrenBeyondMax);
        });
      }

      const text = this.dom.document.createElement('span');
      text.className = 'toc-item-text';
      text.textContent = heading.text || '(empty)';
      text.title = heading.text;

      const levelTag = this.dom.document.createElement('span');
      levelTag.className = 'toc-item-level';
      levelTag.textContent = `H${heading.level}`;
      levelTag.setAttribute('aria-hidden', 'true');

      const actions = this.dom.document.createElement('span');
      actions.className = 'toc-item-actions';

      const dragBtn = this.dom.document.createElement('button');
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

      const deleteBtn = this.dom.document.createElement('button');
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
      item.appendChild(levelTag);
      item.appendChild(actions);

      item.addEventListener('click', (e) => {
        e.preventDefault();
        // Clicking a visible heading must also be able to expand its hidden
        // descendants when any H-level mode limits the rendered depth. Keep this
        // behavior consistent with the table-mode tree, while preserving the
        // existing click-to-navigate behavior.
        if (hasChildren) {
          this.toggleHeadingCollapse(heading.pos, hasChildrenBeyondMax);
        }
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

  private refreshTableModeControl(): void {
    if (!this.tableModeToggleBtn) return;
    this.saveTableMode();
    this.tableModeToggleBtn.textContent = '表格目录';
    this.tableModeToggleBtn.setAttribute('role', 'switch');
    this.tableModeToggleBtn.setAttribute('aria-checked', String(this.tableMode));
    this.tableModeToggleBtn.classList.toggle('active', this.tableMode);
    const detailModeBtn = this.tableModeToggleBtn.parentElement?.firstElementChild as HTMLButtonElement | null;
    if (detailModeBtn) detailModeBtn.textContent = '全文目录';
    detailModeBtn?.classList.toggle('active', !this.tableMode);
    this.tableModeToggleBtn.title = this.tableMode ? '显示文档标题目录' : '显示文档第一个表格目录树';
  }

  private renderTableTree(): void {
    if (!this.tocList) return;
    this.activeTablePathKey = null;
    const table = (this.view.dom.matches('table') ? this.view.dom : this.view.dom.querySelector('table'))
      ?? this.dom.query('#editor .ProseMirror table')
      ?? this.dom.query('.ProseMirror table');
    const tableElement = table as HTMLTableElement | null;
    if (!tableElement) {
      const empty = this.dom.document.createElement('li');
      empty.className = 'toc-table-empty';
      empty.textContent = '正在加载表格…';
      this.tocList.appendChild(empty);
      // NodeViews can mount after the editor transaction that opens the sidebar.
      // Retry once after layout without changing the existing document model.
      setTimeout(() => { if (this.isVisible && this.tableMode) this.renderList(); }, 120);
      return;
    }
    const rows = Array.from(tableElement.rows).slice(1);
    const headers = Array.from(tableElement.rows[0]?.cells ?? []).map(cell => cell.textContent?.trim() ?? '');
    const logicalColumnCount = Math.max(
      headers.length,
      ...rows.map(row => Array.from(row.cells).reduce((total, cell) => total + Math.max(1, cell.colSpan || 1), 0)),
    );
    const depth = Math.min(4, logicalColumnCount);
    const tree = new Map<string, { path: string[]; childCount: number; itemCount: number }>();
    this.tableTreeRows = [];
    // Reconstruct the logical grid so rowspan cells continue to label every
    // following data row instead of shifting later columns to the left.
    const occupied: Array<Array<string | undefined>> = [];
    rows.forEach((row, rowIndex) => {
      const logical: string[] = [];
      let column = 0;
      Array.from(row.cells).forEach(cell => {
        while (occupied[rowIndex]?.[column] !== undefined) column += 1;
        const text = cell.textContent?.trim() ?? '';
        const colspan = Math.max(1, cell.colSpan || 1);
        const rowspan = Math.max(1, cell.rowSpan || 1);
        for (let r = 0; r < rowspan; r++) {
          const targetRow = rowIndex + r;
          if (!occupied[targetRow]) occupied[targetRow] = [];
          for (let c = 0; c < colspan; c++) occupied[targetRow][column + c] = text;
        }
        column += colspan;
      });
      for (let i = 0; i < depth; i++) logical.push(occupied[rowIndex]?.[i] ?? '');
      while (logical.length && !logical[logical.length - 1]) logical.pop();
      if (!logical.length) return;
      this.tableTreeRows.push({ path: logical, row });
      logical.forEach((_, index) => {
        const key = logical.slice(0, index + 1).join('\u0001');
        if (!tree.has(key)) tree.set(key, { path: logical.slice(0, index + 1), childCount: 0, itemCount: 0 });
      });
    });
    tree.forEach((node, key) => {
      node.itemCount = this.tableTreeRows.filter(({ path }) => node.path.every((value, index) => path[index] === value)).length;
      const childKeys = new Set<string>();
      tree.forEach((_, candidateKey) => {
        if (candidateKey.startsWith(`${key}\u0001`)) {
          const remainder = candidateKey.slice(key.length + 1);
          if (!remainder.includes('\u0001')) childKeys.add(candidateKey);
        }
      });
      node.childCount = childKeys.size;
    });
    if (!tree.size) { const empty = this.dom.document.createElement('li'); empty.className = 'toc-table-empty'; empty.textContent = '表格暂无目录数据'; this.tocList.appendChild(empty); return; }
    // Drop collapse/expand overrides for nodes that no longer exist after table edits.
    this.collapsedTablePathKeys.forEach((key) => {
      if (!tree.has(key)) this.collapsedTablePathKeys.delete(key);
    });
    this.expandedTablePathKeys.forEach((key) => {
      if (!tree.has(key)) this.expandedTablePathKeys.delete(key);
    });
    const maxDepth = this.maxVisibleLevel ?? Number.POSITIVE_INFINITY;
    tree.forEach(node => {
      if (!this.isTablePathVisible(node.path, maxDepth)) return;
      const item = this.dom.document.createElement('li');
      item.className = 'toc-table-item';
      item.dataset.depth = String(node.path.length);
      const pathKey = node.path.join('\u0001');
      // Icon must match reality: ▾ only when at least one direct child is currently listed.
      const hasVisibleChild = this.hasVisibleDirectTableChild(tree, pathKey, maxDepth);
      const isCollapsed = node.childCount > 0 && !hasVisibleChild;

      const toggleBtn = this.dom.document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'toc-table-node-toggle';
      if (node.childCount <= 0) {
        toggleBtn.classList.add('empty');
        toggleBtn.disabled = true;
        toggleBtn.textContent = '';
        toggleBtn.title = 'No child nodes';
      } else {
        toggleBtn.textContent = isCollapsed ? '▸' : '▾';
        toggleBtn.title = isCollapsed ? 'Expand children' : 'Collapse children';
        toggleBtn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.toggleTablePathCollapse(pathKey, tree, maxDepth);
        });
      }

      const btn = this.dom.document.createElement('button');
      btn.type = 'button';
      btn.className = 'toc-table-node';
      btn.dataset.depth = String(node.path.length);
      btn.dataset.path = pathKey;
      const label = this.dom.document.createElement('span');
      label.className = 'toc-table-node-label';
      label.textContent = node.path[node.path.length - 1];
      label.title = node.path.join(' / ');
      const count = this.dom.document.createElement('span');
      count.className = 'toc-table-node-count';
      count.textContent = node.childCount ? `${node.childCount} · ${node.itemCount}` : `${node.itemCount}`;
      btn.append(label, count);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (node.childCount > 0) {
          this.toggleTablePathCollapse(pathKey, tree, maxDepth);
        }
        this.clickedTablePathKey = pathKey;
        this.programmaticScroll = true;
        this.applyActiveTableClass(pathKey);
        this.revealTableRows(node.path);
        setTimeout(() => { this.programmaticScroll = false; }, 600);
      });
      item.append(toggleBtn, btn);
      this.tocList!.appendChild(item);
    });
    this.highlightActiveTableNode();
  }

  /** True when any strict ancestor of this path is collapsed. */
  private isTablePathHiddenByCollapse(path: string[]): boolean {
    for (let i = 1; i < path.length; i += 1) {
      if (this.collapsedTablePathKeys.has(path.slice(0, i).join('\u0001'))) return true;
    }
    return false;
  }

  private isDirectTableChildKey(parentKey: string, candidateKey: string): boolean {
    if (!candidateKey.startsWith(`${parentKey}\u0001`)) return false;
    return !candidateKey.slice(parentKey.length + 1).includes('\u0001');
  }

  private tableNodeHasDescendantBeyondMax(
    tree: Map<string, { path: string[]; childCount: number; itemCount: number }>,
    pathKey: string,
    maxDepth: number,
  ): boolean {
    if (!Number.isFinite(maxDepth)) return false;
    for (const [key, node] of tree) {
      if (key.startsWith(`${pathKey}\u0001`) && node.path.length > maxDepth) return true;
    }
    return false;
  }

  private hasVisibleDirectTableChild(
    tree: Map<string, { path: string[]; childCount: number; itemCount: number }>,
    pathKey: string,
    maxDepth: number,
  ): boolean {
    for (const [key, node] of tree) {
      if (!this.isDirectTableChildKey(pathKey, key)) continue;
      if (this.isTablePathVisible(node.path, maxDepth)) return true;
    }
    return false;
  }

  private toggleTablePathCollapse(
    pathKey: string,
    tree: Map<string, { path: string[]; childCount: number; itemCount: number }>,
    maxDepth: number,
  ): void {
    const hasVisibleChild = this.hasVisibleDirectTableChild(tree, pathKey, maxDepth);
    if (hasVisibleChild) {
      this.collapsedTablePathKeys.add(pathKey);
      this.expandedTablePathKeys.delete(pathKey);
    } else {
      this.collapsedTablePathKeys.delete(pathKey);
      if (this.tableNodeHasDescendantBeyondMax(tree, pathKey, maxDepth)) {
        this.expandedTablePathKeys.add(pathKey);
      }
    }
    this.renderList();
    this.saveExpandState();
  }

  /**
   * H1–H5 filters limit the default depth. Nodes deeper than the filter stay
   * reachable by expanding an ancestor, matching normal-mode heading TOC.
   */
  private isTablePathVisible(path: string[], maxDepth: number): boolean {
    if (this.isTablePathHiddenByCollapse(path)) return false;
    if (path.length <= maxDepth) return true;
    for (let i = 1; i < path.length; i += 1) {
      if (this.expandedTablePathKeys.has(path.slice(0, i).join('\u0001'))) return true;
    }
    return false;
  }

  private revealTableRows(path: string[]): void {
    const matches = this.tableTreeRows.filter(({ path: rowPath }) => path.every((value, i) => rowPath[i] === value));
    this.tableTreeRows.forEach(({ row }) => row.classList.remove('toc-table-row-match'));
    matches.forEach(({ row }) => row.classList.add('toc-table-row-match'));
    matches[0]?.row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (matches.length) setTimeout(() => matches.forEach(({ row }) => row.classList.remove('toc-table-row-match')), 1600);
  }

  /** Highlight the TOC node matching the table row currently near the viewport top. */
  private highlightActiveTableNode(): void {
    if (!this.tocList || !this.tableMode || this.tableTreeRows.length === 0) return;

    if (this.clickedTablePathKey !== null) {
      if (this.clickedTablePathKey === this.activeTablePathKey) return;
      this.applyActiveTableClass(this.clickedTablePathKey);
      return;
    }

    if (!this.scrollAreaEl) return;
    const scrollRect = this.scrollAreaEl.getBoundingClientRect();
    const offset = 96;

    let activePath: string[] | null = null;
    for (const { path, row } of this.tableTreeRows) {
      const top = row.getBoundingClientRect().top - scrollRect.top;
      if (top <= offset) activePath = path;
      else if (activePath) break;
    }

    if (!activePath) {
      for (const { path, row } of this.tableTreeRows) {
        const rect = row.getBoundingClientRect();
        if (rect.bottom > scrollRect.top && rect.top < scrollRect.bottom) {
          activePath = path;
          break;
        }
      }
    }
    if (!activePath) return;

    const maxDepth = this.maxVisibleLevel ?? Number.POSITIVE_INFINITY;
    let pathKey: string | null = null;
    for (let d = activePath.length; d >= 1; d -= 1) {
      const candidate = activePath.slice(0, d).join('\u0001');
      if (d > maxDepth && !this.isTablePathVisible(activePath.slice(0, d), maxDepth)) continue;
      let found = false;
      this.tocList.querySelectorAll('.toc-table-node').forEach((node) => {
        if ((node as HTMLElement).dataset.path === candidate) found = true;
      });
      if (found) {
        pathKey = candidate;
        break;
      }
    }
    if (!pathKey) {
      const depth = Math.min(activePath.length, maxDepth);
      pathKey = activePath.slice(0, depth).join('\u0001');
    }    if (pathKey === this.activeTablePathKey) return;
    this.applyActiveTableClass(pathKey);
  }

  private applyActiveTableClass(pathKey: string): void {
    if (!this.tocList) return;
    this.activeTablePathKey = pathKey;
    let activeNode: HTMLElement | null = null;
    this.tocList.querySelectorAll('.toc-table-node').forEach((node) => {
      const isActive = (node as HTMLElement).dataset.path === pathKey;
      node.classList.toggle('active', isActive);
      if (isActive) activeNode = node as HTMLElement;
    });
    const nodeToScroll = activeNode as HTMLElement | null;
    nodeToScroll?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    const key = this.headingKeyForPos(heading.pos);
    if (key) {
      this.collapsedHeadingKeys.delete(key);
      this.expandedHeadingKeys.delete(key);
    }
    this.clickedPos = null;
    this.view.dispatch(tr);
    this.view.focus();
    this.saveExpandState();
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

  private toggleHeadingCollapse(headingPos: number, hasChildrenBeyondMax: boolean): void {
    const key = this.headingKeyForPos(headingPos);
    if (!key) return;
    const explicitCollapsedNow = this.collapsedHeadingKeys.has(key);
    const expandedOverrideNow = this.expandedHeadingKeys.has(key);
    const levelCollapsedNow = this.maxVisibleLevel !== null
      && hasChildrenBeyondMax
      && !expandedOverrideNow;

    if (explicitCollapsedNow) {
      this.collapsedHeadingKeys.delete(key);
    } else if (levelCollapsedNow) {
      this.expandedHeadingKeys.add(key);
      this.collapsedHeadingKeys.delete(key);
    } else if (expandedOverrideNow) {
      this.expandedHeadingKeys.delete(key);
    } else {
      this.collapsedHeadingKeys.add(key);
      this.expandedHeadingKeys.delete(key);
    }
    this.renderList();
    this.saveExpandState();
  }

  private computeVisibleHeadings(): HeadingEntry[] {
    if (this.headings.length === 0) return [];
    const result: HeadingEntry[] = [];
    const maxVisible = this.maxVisibleLevel ?? Number.POSITIVE_INFINITY;
    const parentIndices: Array<number | null> = [];
    const stack: number[] = [];

    for (let index = 0; index < this.headings.length; index += 1) {
      const heading = this.headings[index];
      while (stack.length > 0 && this.headings[stack[stack.length - 1]].level >= heading.level) {
        stack.pop();
      }
      parentIndices[index] = stack.length > 0 ? stack[stack.length - 1] : null;
      stack.push(index);
    }

    const visibilityCache = new Map<number, boolean>();
    const isVisible = (index: number): boolean => {
      const cached = visibilityCache.get(index);
      if (cached !== undefined) return cached;

      const heading = this.headings[index];
      const parentIndex = parentIndices[index];
      if (parentIndex !== null && !isVisible(parentIndex)) {
        visibilityCache.set(index, false);
        return false;
      }
      if (parentIndex !== null && this.isHeadingCollapsed(this.headings[parentIndex].pos)) {
        visibilityCache.set(index, false);
        return false;
      }

      let visible = heading.level <= maxVisible;
      if (!visible && parentIndex !== null) {
        // A filtered-out heading becomes visible only when its immediate
        // parent is expanded. This prevents one click from revealing every
        // deeper descendant at once.
        visible = this.isHeadingExpanded(this.headings[parentIndex].pos);
      }
      visibilityCache.set(index, visible);
      return visible;
    };

    for (let index = 0; index < this.headings.length; index += 1) {
      if (isVisible(index)) result.push(this.headings[index]);
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
    const activeElement = activeItem as HTMLElement | null;
    if (activeElement) {
      activeElement.scrollIntoView({
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
      if (!this.programmaticScroll) {
        if (this.clickedPos !== null) this.clickedPos = null;
        if (this.clickedTablePathKey !== null) this.clickedTablePathKey = null;
      }

      if (this.throttleTimer) return;
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        if (this.tableMode) this.highlightActiveTableNode();
        else this.highlightActiveHeading();
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

  /** Persist expand/collapse state per markdown file path (absolute). */
  public setFilePath(filePath: string): void {
    if (filePath === this.currentFilePath) return;
    this.saveExpandState();
    this.currentFilePath = filePath;
    this.loadExpandState();
    this.headings = [];
    this.headingPosToKey.clear();
    this.refreshLevelControls();
    // Do not renderList here: empty headings would prune restored keys.
    // update()/open() will render after the new document content is applied.
  }

  /** Called from dispatchTransaction on every state change */
  public update(view: EditorView, transaction?: { docChanged?: boolean; selectionSet?: boolean }): void {
    this.view = view;
    if (!this.isVisible) return;

    const newHeadings = this.extractHeadings(view.state.doc);

    if (this.tableMode) {
      if (transaction?.docChanged) this.renderList();
      else this.highlightActiveTableNode();
      return;
    }

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
    this.applySidebarWidth();
    this.dom.themeRoot.classList.add('toc-visible');

    // Reset filter
    this.filterText = '';
    if (this.filterInput) this.filterInput.value = '';

    this.headings = this.extractHeadings(this.view.state.doc);
    this.refreshTableModeControl();
    this.activeIndex = -1;
    this.renderList();
    this.scheduleLayoutChangeNotifications();
  }

  public close(): void {
    if (!this.isVisible) return;
    this.isVisible = false;
    this.isResizingSidebar = false;
    this.sidebar?.classList.remove('resizing');
    this.sidebar?.classList.add('hidden');
    this.dom.themeRoot.classList.remove('toc-visible');
    this.scheduleLayoutChangeNotifications();
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

  public setWidth(width: number): void {
    this.applySidebarWidth(width);
    this.saveSidebarWidth();
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
