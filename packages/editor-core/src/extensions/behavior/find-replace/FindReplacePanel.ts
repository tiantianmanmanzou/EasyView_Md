/**
 * Find & Replace Panel (Vanilla JS)
 *
 * Keyboard shortcuts:
 * - Ctrl/Cmd+F: Open find
 * - Ctrl/Cmd+H: Open with replace
 * - Enter: Next match
 * - Shift+Enter: Previous match
 * - Ctrl/Cmd+Enter: Replace all
 * - Escape: Close
 */

import type { EditorView } from 'prosemirror-view';
import {
  find,
  nextMatch,
  prevMatch,
  replaceCurrent,
  replaceAll,
  clearSearch,
  closeFindAndReplace,
  findAndReplaceKey,
} from './FindReplacePlugin';

export interface FindPanelSourceEditor {
  search(query: string, caseSensitive: boolean, regexEnabled: boolean): { results: Array<{ from: number; to: number }>; currentIndex: number };
  getSearchState(): { results: Array<{ from: number; to: number }>; currentIndex: number };
  goToMatch(index: number): void;
  nextMatch(): void;
  prevMatch(): void;
  replaceCurrent(replaceText: string): void;
  replaceAllMatches(replaceText: string): void;
  clearSearch(): void;
  focus(): void;
}

interface PanelPosition {
  left: number;
  top: number;
}

const POSITION_KEY = 'easyview-find-replace-position';
const PANEL_MARGIN = 8;
const DEFAULT_OFFSET = 16;

export class FindAndReplacePanel {
  private view: EditorView;
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window;
  private panel: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private replaceInput: HTMLInputElement | null = null;
  private counter: HTMLElement | null = null;
  private replaceSection: HTMLElement | null = null;
  private caseSensitiveBtn: HTMLButtonElement | null = null;
  private regexBtn: HTMLButtonElement | null = null;
  private toggleBtn: HTMLButtonElement | null = null;

  private caseSensitive = false;
  private regexEnabled = false;
  private showReplace = true;
  private position: PanelPosition = { left: DEFAULT_OFFSET, top: DEFAULT_OFFSET };
  private dragging = false;

  private readonly onWindowResize = (): void => {
    this.applyPosition(this.position, false);
  };
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const isModKey = e.ctrlKey || e.metaKey;
    if (isModKey && e.code === 'KeyF' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.open();
    }
    if (isModKey && e.code === 'KeyH' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      this.open(true);
    }
  };

  private _getSourceEditor: (() => FindPanelSourceEditor | null) | null = null;
  private _getIsSourceMode: (() => boolean) | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.ownerDocument = view.dom.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView ?? window;
    this.ensureStyles();
    this.position = this.loadPosition() ?? this.position;
    this.createPanel();
    this.attachKeyboardShortcuts();
    this.ownerWindow.addEventListener('resize', this.onWindowResize);
  }

  /** Set source mode callbacks for dual-mode find/replace */
  setSourceCallbacks(getSourceEditor: () => FindPanelSourceEditor | null, getIsSourceMode: () => boolean) {
    this._getSourceEditor = getSourceEditor;
    this._getIsSourceMode = getIsSourceMode;
  }

  private get isSourceMode(): boolean {
    return this._getIsSourceMode?.() ?? false;
  }

  private get sourceEditor(): FindPanelSourceEditor | null {
    return this._getSourceEditor?.() ?? null;
  }

  private ensureStyles(): void {
    const styleId = 'easyview-find-replace-float-styles';
    if (this.ownerDocument.getElementById(styleId)) return;
    const style = this.ownerDocument.createElement('style');
    style.id = styleId;
    style.textContent = `
      .find-replace-panel {
        position: fixed !important;
        top: ${DEFAULT_OFFSET}px;
        right: auto !important;
        left: auto;
        z-index: 1000;
        display: none;
        flex-direction: column;
        align-items: stretch;
        gap: 8px;
        width: max-content;
        max-width: calc(100vw - ${PANEL_MARGIN * 2}px);
        padding: 10px 12px;
        background: var(--vscode-editorWidget-background, #252526);
        border: 1px solid var(--vscode-editorWidget-border, #454545) !important;
        border-radius: 12px !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
        cursor: grab;
        user-select: none;
      }
      .find-replace-panel.open { display: flex !important; }
      .find-replace-panel.dragging { cursor: grabbing; }
      .find-replace-content { display: flex; flex-direction: column; gap: 8px; }
      .find-replace-row { display: flex; align-items: center; gap: 8px; }
      .find-replace-input-group {
        display: flex;
        align-items: center;
        flex: 0 0 220px;
        width: 220px;
        min-width: 220px;
        max-width: 220px;
        height: 28px;
        box-sizing: border-box;
        overflow: hidden;
        background: var(--vscode-input-background, #3c3c3c);
        border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
        border-radius: 8px;
        padding: 0 8px;
      }
      .find-replace-input-group:focus-within {
        border-color: var(--mdpre-accent, var(--vscode-focusBorder, #65aaf5));
      }
      .find-replace-input,
      .find-replace-input:hover,
      .find-replace-input:focus,
      .find-replace-input:focus-visible,
      .find-replace-input:active {
        all: unset;
        display: block;
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        height: 26px;
        color: var(--vscode-input-foreground, #cccccc);
        font: inherit;
        font-size: 13px;
        line-height: 26px;
        caret-color: var(--vscode-input-foreground, #cccccc);
        cursor: text;
        user-select: text;
        appearance: none;
        -webkit-appearance: none;
        background: transparent;
        border: 0;
        outline: none;
        box-shadow: none;
      }
      .find-replace-input::placeholder {
        color: var(--vscode-input-placeholderForeground, #6c6c6c);
      }
      .find-replace-options { display: flex; gap: 2px; border-left: 0; padding-left: 0; margin-left: 0; }
      .find-replace-panel button { cursor: pointer; user-select: none; }
    `;
    this.ownerDocument.head.appendChild(style);
  }

  private createPanel() {
    this.panel = this.ownerDocument.createElement('div');
    this.panel.className = 'find-replace-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Find and replace');

    const content = this.ownerDocument.createElement('div');
    content.className = 'find-replace-content';

    const searchRow = this.createSearchRow();
    content.appendChild(searchRow);

    this.replaceSection = this.createReplaceRow();
    content.appendChild(this.replaceSection);

    this.panel.appendChild(content);
    this.panel.addEventListener('pointerdown', (event) => this.beginDrag(event));
    this.ownerDocument.body.appendChild(this.panel);
    this.syncReplaceVisibility();
    this.applyPosition(this.position, false);
  }

  private createSearchRow(): HTMLElement {
    const row = this.ownerDocument.createElement('div');
    row.className = 'find-replace-row';

    const inputGroup = this.ownerDocument.createElement('div');
    inputGroup.className = 'find-replace-input-group';

    this.searchInput = this.ownerDocument.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.className = 'find-replace-input';
    this.searchInput.placeholder = 'Find';
    this.searchInput.addEventListener('input', () => this.handleSearch());
    this.searchInput.addEventListener('keydown', (e) => this.handleSearchKeyDown(e));
    inputGroup.appendChild(this.searchInput);
    row.appendChild(inputGroup);

    const options = this.ownerDocument.createElement('div');
    options.className = 'find-replace-options';

    this.caseSensitiveBtn = this.ownerDocument.createElement('button');
    this.caseSensitiveBtn.type = 'button';
    this.caseSensitiveBtn.className = 'find-replace-option-btn';
    this.caseSensitiveBtn.textContent = 'Aa';
    this.caseSensitiveBtn.title = 'Case Sensitive (Alt+C)';
    this.caseSensitiveBtn.onclick = () => this.toggleCaseSensitive();
    options.appendChild(this.caseSensitiveBtn);

    this.regexBtn = this.ownerDocument.createElement('button');
    this.regexBtn.type = 'button';
    this.regexBtn.className = 'find-replace-option-btn';
    this.regexBtn.textContent = '.*';
    this.regexBtn.title = 'Use Regular Expression (Alt+R)';
    this.regexBtn.onclick = () => this.toggleRegex();
    options.appendChild(this.regexBtn);

    row.appendChild(options);

    const nav = this.ownerDocument.createElement('div');
    nav.className = 'find-replace-navigation';

    const prevBtn = this.ownerDocument.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'find-replace-nav-btn';
    prevBtn.textContent = '↑';
    prevBtn.title = 'Previous Match (Shift+Enter)';
    prevBtn.onclick = () => this.handlePrev();
    nav.appendChild(prevBtn);

    const nextBtn = this.ownerDocument.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'find-replace-nav-btn';
    nextBtn.textContent = '↓';
    nextBtn.title = 'Next Match (Enter)';
    nextBtn.onclick = () => this.handleNext();
    nav.appendChild(nextBtn);

    this.counter = this.ownerDocument.createElement('span');
    this.counter.className = 'find-replace-counter';
    this.counter.textContent = 'No results';
    nav.appendChild(this.counter);
    row.appendChild(nav);

    this.toggleBtn = this.ownerDocument.createElement('button');
    this.toggleBtn.type = 'button';
    this.toggleBtn.className = 'find-replace-toggle-btn';
    this.toggleBtn.textContent = '▼';
    this.toggleBtn.title = 'Toggle Replace';
    this.toggleBtn.onclick = () => this.toggleReplace();
    row.appendChild(this.toggleBtn);

    const closeBtn = this.ownerDocument.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'find-replace-close-btn';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close (Escape)';
    closeBtn.onclick = () => this.close();
    row.appendChild(closeBtn);

    return row;
  }

  private createReplaceRow(): HTMLElement {
    const row = this.ownerDocument.createElement('div');
    row.className = 'find-replace-row find-replace-row-replace';

    const inputGroup = this.ownerDocument.createElement('div');
    inputGroup.className = 'find-replace-input-group';

    this.replaceInput = this.ownerDocument.createElement('input');
    this.replaceInput.type = 'text';
    this.replaceInput.className = 'find-replace-input';
    this.replaceInput.placeholder = 'Replace';
    this.replaceInput.addEventListener('keydown', (e) => this.handleReplaceKeyDown(e));
    inputGroup.appendChild(this.replaceInput);
    row.appendChild(inputGroup);

    const actions = this.ownerDocument.createElement('div');
    actions.className = 'find-replace-actions';

    const replaceBtn = this.ownerDocument.createElement('button');
    replaceBtn.type = 'button';
    replaceBtn.className = 'find-replace-action-btn';
    replaceBtn.textContent = 'Replace';
    replaceBtn.title = 'Replace (Enter)';
    replaceBtn.onclick = () => this.handleReplace();
    actions.appendChild(replaceBtn);

    const replaceAllBtn = this.ownerDocument.createElement('button');
    replaceAllBtn.type = 'button';
    replaceAllBtn.className = 'find-replace-action-btn';
    replaceAllBtn.textContent = 'Replace All';
    replaceAllBtn.title = 'Replace All (Ctrl+Enter)';
    replaceAllBtn.onclick = () => this.handleReplaceAll();
    actions.appendChild(replaceAllBtn);

    row.appendChild(actions);
    return row;
  }

  private handleSearch() {
    const searchTerm = this.searchInput?.value || '';
    if (this.isSourceMode && this.sourceEditor) {
      if (searchTerm) {
        this.sourceEditor.search(searchTerm, this.caseSensitive, this.regexEnabled);
      } else {
        this.sourceEditor.clearSearch();
      }
    } else {
      if (searchTerm) {
        find(searchTerm, this.caseSensitive, this.regexEnabled)(this.view.state, this.view.dispatch);
      } else {
        clearSearch()(this.view.state, this.view.dispatch);
      }
    }
    this.updateCounter();
  }

  private handleNext() {
    if (this.isSourceMode && this.sourceEditor) {
      this.sourceEditor.nextMatch();
    } else {
      nextMatch()(this.view.state, this.view.dispatch);
    }
    this.updateCounter();
  }

  private handlePrev() {
    if (this.isSourceMode && this.sourceEditor) {
      this.sourceEditor.prevMatch();
    } else {
      prevMatch()(this.view.state, this.view.dispatch);
    }
    this.updateCounter();
  }

  private handleReplace() {
    const replaceTerm = this.replaceInput?.value || '';
    if (this.isSourceMode && this.sourceEditor) {
      this.sourceEditor.replaceCurrent(replaceTerm);
      const searchTerm = this.searchInput?.value || '';
      if (searchTerm) this.sourceEditor.search(searchTerm, this.caseSensitive, this.regexEnabled);
    } else {
      replaceCurrent(replaceTerm)(this.view.state, this.view.dispatch);
    }
    this.updateCounter();
  }

  private handleReplaceAll() {
    const replaceTerm = this.replaceInput?.value || '';
    if (this.isSourceMode && this.sourceEditor) {
      this.sourceEditor.replaceAllMatches(replaceTerm);
      const searchTerm = this.searchInput?.value || '';
      if (searchTerm) this.sourceEditor.search(searchTerm, this.caseSensitive, this.regexEnabled);
    } else {
      replaceAll(replaceTerm)(this.view.state, this.view.dispatch);
    }
    this.updateCounter();
  }

  private toggleCaseSensitive() {
    this.caseSensitive = !this.caseSensitive;
    this.caseSensitiveBtn?.classList.toggle('active', this.caseSensitive);
    this.handleSearch();
  }

  private toggleRegex() {
    this.regexEnabled = !this.regexEnabled;
    this.regexBtn?.classList.toggle('active', this.regexEnabled);
    this.handleSearch();
  }

  private toggleReplace() {
    this.showReplace = !this.showReplace;
    this.syncReplaceVisibility();
  }

  private syncReplaceVisibility(): void {
    if (this.replaceSection) {
      this.replaceSection.style.display = this.showReplace ? 'flex' : 'none';
    }
    if (this.toggleBtn) {
      this.toggleBtn.textContent = this.showReplace ? '▼' : '▶';
    }
  }

  private handleSearchKeyDown(e: KeyboardEvent) {
    if (e.code === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        this.handlePrev();
      } else {
        this.handleNext();
      }
    } else if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  private handleReplaceKeyDown(e: KeyboardEvent) {
    if (e.code === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.handleReplaceAll();
      } else {
        this.handleReplace();
      }
    } else if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  private updateCounter() {
    if (!this.counter) return;

    let currentIndex = -1;
    let totalResults = 0;

    if (this.isSourceMode && this.sourceEditor) {
      const state = this.sourceEditor.getSearchState();
      currentIndex = state.currentIndex;
      totalResults = state.results.length;
    } else {
      const pluginState = findAndReplaceKey.getState(this.view.state);
      if (!pluginState) return;
      currentIndex = pluginState.currentIndex;
      totalResults = pluginState.results.length;
    }

    if (totalResults > 0) {
      this.counter.textContent = `${currentIndex + 1} / ${totalResults}`;
    } else {
      this.counter.textContent = 'No results';
    }
  }

  private attachKeyboardShortcuts() {
    this.ownerDocument.addEventListener('keydown', this.onKeyDown);
  }

  private isInteractiveTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, button, select, a'));
  }

  private beginDrag(event: PointerEvent): void {
    if (!this.panel || this.isInteractiveTarget(event.target)) return;
    event.preventDefault();
    this.dragging = true;
    this.panel.classList.add('dragging');

    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = this.position.left;
    const startTop = this.position.top;

    const onMove = (moveEvent: PointerEvent) => {
      this.applyPosition({
        left: startLeft + (moveEvent.clientX - startX),
        top: startTop + (moveEvent.clientY - startY),
      }, false);
    };
    const onUp = () => {
      this.dragging = false;
      this.panel?.classList.remove('dragging');
      this.savePosition(this.position);
      this.ownerWindow.removeEventListener('pointermove', onMove);
      this.ownerWindow.removeEventListener('pointerup', onUp);
    };

    this.ownerWindow.addEventListener('pointermove', onMove);
    this.ownerWindow.addEventListener('pointerup', onUp);
  }

  private loadPosition(): PanelPosition | null {
    try {
      const raw = this.ownerWindow.localStorage.getItem(POSITION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PanelPosition>;
      if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null;
      if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;
      return { left: parsed.left, top: parsed.top };
    } catch {
      return null;
    }
  }

  private savePosition(position: PanelPosition): void {
    try {
      this.ownerWindow.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    } catch {
      // Webview storage can be unavailable in restricted environments.
    }
  }

  private defaultPosition(): PanelPosition {
    const width = this.panel?.offsetWidth || 420;
    const viewportWidth = this.ownerWindow.innerWidth || 800;
    return {
      left: Math.max(PANEL_MARGIN, viewportWidth - width - DEFAULT_OFFSET),
      top: DEFAULT_OFFSET,
    };
  }

  private clampPosition(position: PanelPosition): PanelPosition {
    const width = this.panel?.offsetWidth || 420;
    const height = this.panel?.offsetHeight || 80;
    const viewportWidth = this.ownerWindow.innerWidth || 800;
    const viewportHeight = this.ownerWindow.innerHeight || 600;
    const maxLeft = Math.max(PANEL_MARGIN, viewportWidth - width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, viewportHeight - height - PANEL_MARGIN);
    return {
      left: Math.max(PANEL_MARGIN, Math.min(position.left, maxLeft)),
      top: Math.max(PANEL_MARGIN, Math.min(position.top, maxTop)),
    };
  }

  private applyPosition(position: PanelPosition, persist: boolean): void {
    if (!this.panel) return;
    this.position = this.clampPosition(position);
    this.panel.style.left = `${this.position.left}px`;
    this.panel.style.top = `${this.position.top}px`;
    this.panel.style.right = 'auto';
    if (persist) this.savePosition(this.position);
  }

  public open(withReplace = false) {
    if (!this.panel) return;

    if (withReplace) this.showReplace = true;
    this.syncReplaceVisibility();
    this.panel.classList.add('open');
    const next = this.loadPosition() ?? this.defaultPosition();
    this.applyPosition(next, false);
    this.ownerWindow.requestAnimationFrame(() => {
      if (!this.panel?.classList.contains('open')) return;
      this.applyPosition(this.position, false);
    });

    if (this.searchInput) {
      this.searchInput.focus();
      this.searchInput.select();
    }

    this.updateCounter();
  }

  public close() {
    if (!this.panel) return;

    this.panel.classList.remove('open');
    if (this.isSourceMode && this.sourceEditor) {
      this.sourceEditor.clearSearch();
      this.sourceEditor.focus();
    } else {
      clearSearch()(this.view.state, this.view.dispatch);
      closeFindAndReplace()(this.view.state, this.view.dispatch);
      this.view.focus();
    }
  }

  public destroy() {
    this.ownerDocument.removeEventListener('keydown', this.onKeyDown);
    this.ownerWindow.removeEventListener('resize', this.onWindowResize);
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }
}
