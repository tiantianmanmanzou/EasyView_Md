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

export class FindAndReplacePanel {
  private view: EditorView;
  private panel: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private replaceInput: HTMLInputElement | null = null;
  private counter: HTMLElement | null = null;
  private replaceSection: HTMLElement | null = null;
  private caseSensitiveBtn: HTMLElement | null = null;
  private regexBtn: HTMLElement | null = null;

  private caseSensitive = false;
  private regexEnabled = false;
  private showReplace = false;

  private _getSourceEditor: (() => FindPanelSourceEditor | null) | null = null;
  private _getIsSourceMode: (() => boolean) | null = null;

  constructor(view: EditorView) {
    this.view = view;
    this.createPanel();
    this.attachKeyboardShortcuts();
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

  private createPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'find-replace-panel';
    this.panel.style.display = 'none';

    const content = document.createElement('div');
    content.className = 'find-replace-content';

    // Search row
    const searchRow = this.createSearchRow();
    content.appendChild(searchRow);

    // Replace row (initially hidden)
    this.replaceSection = this.createReplaceRow();
    content.appendChild(this.replaceSection);

    this.panel.appendChild(content);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'find-replace-close-btn';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close (Escape)';
    closeBtn.onclick = () => this.close();
    this.panel.appendChild(closeBtn);

    document.body.appendChild(this.panel);
  }

  private createSearchRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'find-replace-row';

    // Input group
    const inputGroup = document.createElement('div');
    inputGroup.className = 'find-replace-input-group';

    this.searchInput = document.createElement('input');
    this.searchInput.type = 'text';
    this.searchInput.className = 'find-replace-input';
    this.searchInput.placeholder = 'Find';
    this.searchInput.addEventListener('input', () => this.handleSearch());
    this.searchInput.addEventListener('keydown', (e) => this.handleSearchKeyDown(e));
    inputGroup.appendChild(this.searchInput);

    // Options
    const options = document.createElement('div');
    options.className = 'find-replace-options';

    this.caseSensitiveBtn = document.createElement('button');
    this.caseSensitiveBtn.className = 'find-replace-option-btn';
    this.caseSensitiveBtn.textContent = 'Aa';
    this.caseSensitiveBtn.title = 'Case Sensitive (Alt+C)';
    this.caseSensitiveBtn.onclick = () => this.toggleCaseSensitive();
    options.appendChild(this.caseSensitiveBtn);

    this.regexBtn = document.createElement('button');
    this.regexBtn.className = 'find-replace-option-btn';
    this.regexBtn.textContent = '.*';
    this.regexBtn.title = 'Use Regular Expression (Alt+R)';
    this.regexBtn.onclick = () => this.toggleRegex();
    options.appendChild(this.regexBtn);

    inputGroup.appendChild(options);
    row.appendChild(inputGroup);

    // Navigation
    const nav = document.createElement('div');
    nav.className = 'find-replace-navigation';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'find-replace-nav-btn';
    prevBtn.textContent = '↑';
    prevBtn.title = 'Previous Match (Shift+Enter)';
    prevBtn.onclick = () => this.handlePrev();
    nav.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.className = 'find-replace-nav-btn';
    nextBtn.textContent = '↓';
    nextBtn.title = 'Next Match (Enter)';
    nextBtn.onclick = () => this.handleNext();
    nav.appendChild(nextBtn);

    this.counter = document.createElement('span');
    this.counter.className = 'find-replace-counter';
    this.counter.textContent = 'No results';
    nav.appendChild(this.counter);

    row.appendChild(nav);

    // Toggle replace button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'find-replace-toggle-btn';
    toggleBtn.textContent = '▶';
    toggleBtn.title = 'Toggle Replace';
    toggleBtn.onclick = () => this.toggleReplace();
    row.appendChild(toggleBtn);

    return row;
  }

  private createReplaceRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'find-replace-row';
    row.style.display = 'none';

    // Input group
    const inputGroup = document.createElement('div');
    inputGroup.className = 'find-replace-input-group';

    this.replaceInput = document.createElement('input');
    this.replaceInput.type = 'text';
    this.replaceInput.className = 'find-replace-input';
    this.replaceInput.placeholder = 'Replace';
    this.replaceInput.addEventListener('keydown', (e) => this.handleReplaceKeyDown(e));
    inputGroup.appendChild(this.replaceInput);

    row.appendChild(inputGroup);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'find-replace-actions';

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'find-replace-action-btn';
    replaceBtn.textContent = 'Replace';
    replaceBtn.title = 'Replace (Enter)';
    replaceBtn.onclick = () => this.handleReplace();
    actions.appendChild(replaceBtn);

    const replaceAllBtn = document.createElement('button');
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
      // Re-search after replace
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
      // Re-search after replace
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
    if (this.replaceSection) {
      this.replaceSection.style.display = this.showReplace ? 'flex' : 'none';
    }
    const toggleBtn = this.panel?.querySelector('.find-replace-toggle-btn');
    if (toggleBtn) {
      toggleBtn.textContent = this.showReplace ? '▼' : '▶';
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
    document.addEventListener('keydown', (e) => {
      const isModKey = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd+F: Open find
      if (isModKey && e.code === 'KeyF' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.open();
      }

      // Ctrl/Cmd+H: Open with replace
      if (isModKey && e.code === 'KeyH' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.open(true);
      }
    });
  }

  public open(withReplace = false) {
    if (!this.panel) return;

    this.panel.style.display = 'flex';

    if (withReplace) {
      this.showReplace = true;
      if (this.replaceSection) {
        this.replaceSection.style.display = 'flex';
      }
      const toggleBtn = this.panel.querySelector('.find-replace-toggle-btn');
      if (toggleBtn) {
        toggleBtn.textContent = '▼';
      }
    }

    // Focus and select search input
    if (this.searchInput) {
      this.searchInput.focus();
      this.searchInput.select();
    }

    this.updateCounter();
  }

  public close() {
    if (!this.panel) return;

    this.panel.style.display = 'none';
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
    if (this.panel) {
      this.panel.remove();
      this.panel = null;
    }
  }
}
