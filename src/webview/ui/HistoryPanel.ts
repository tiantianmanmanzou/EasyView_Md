/**
 * History Panel — slide-out panel that VISUALIZES existing undo/redo state.
 *
 * Reads directly from:
 * - ProseMirror history (undoDepth/redoDepth)
 * - CodeMirror history
 * - EditOperationLog (per-step labels)
 * - DualModeHistory (cross-mode snapshots)
 */

import { undoDepth, redoDepth } from 'prosemirror-history';
import { undoDepth as cmUndoDepth, redoDepth as cmRedoDepth } from '@codemirror/commands';
import type { EditorView } from 'prosemirror-view';
import type { DualModeHistory } from '../editor/DualModeHistory';
import type { EditOperationLog } from '../editor/EditOperationLog';

export interface HistoryPanelDeps {
  getView: () => EditorView | null;
  getDualHistory: () => DualModeHistory;
  getOperationLog: () => EditOperationLog;
  getIsSourceMode: () => boolean;
  getSourceView: () => import('@codemirror/view').EditorView | null;
  triggerUndo: () => void;
  triggerRedo: () => void;
  onVisibilityChange?: (visible: boolean) => void;
}

export class HistoryPanel {
  private panel: HTMLElement;
  private contentEl: HTMLElement;
  private deps: HistoryPanelDeps;
  private _visible = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  get visible() { return this._visible; }

  constructor(deps: HistoryPanelDeps) {
    this.deps = deps;
    this.ensureStyles();
    this.panel = document.createElement('div');
    this.panel.className = 'history-panel hidden';

    const header = document.createElement('div');
    header.className = 'history-panel-header';
    header.innerHTML = `
      <span class="history-panel-title">最近</span>
      <button class="history-panel-close" title="Close">&times;</button>
    `;
    header.querySelector('.history-panel-close')!.addEventListener('click', () => this.close());
    this.panel.appendChild(header);

    this.contentEl = document.createElement('div');
    this.contentEl.className = 'history-panel-content';
    this.panel.appendChild(this.contentEl);

    const editorBody = document.getElementById('editor-body');
    if (editorBody) {
      editorBody.appendChild(this.panel);
    }

    this.attachPanelTransitionListener();
  }

  private ensureStyles(): void {
    if (document.getElementById('easyview-history-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'easyview-history-panel-styles';
    style.textContent = `
      .history-panel {
        transition:
          width 0.2s ease,
          min-width 0.2s ease,
          opacity 0.2s ease,
          padding 0.2s ease,
          border-color 0.2s ease;
      }

      .history-panel.hidden {
        width: 0 !important;
        min-width: 0 !important;
        margin-right: 0 !important;
        opacity: 0;
        pointer-events: none;
        padding-left: 0 !important;
        padding-right: 0 !important;
        border-left-color: transparent !important;
        overflow: hidden;
      }

      .history-panel-content {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }

      .history-operation-list {
        flex: 1;
        overflow-y: auto;
        padding: 6px 0 10px;
        min-height: 0;
      }

      .history-operation-entry {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        padding: 7px 12px;
        border: none;
        background: transparent;
        color: var(--vscode-editor-foreground);
        font-size: 12px;
        line-height: 1.35;
        text-align: left;
        cursor: pointer;
      }

      .history-operation-entry:hover:not(:disabled) {
        background: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.06));
      }

      .history-operation-entry:disabled {
        cursor: default;
      }

      .history-operation-entry.current {
        background: var(--vscode-list-activeSelectionBackground, rgba(64, 128, 208, 0.12));
        font-weight: 500;
      }

      .history-operation-entry.future {
        opacity: 0.45;
      }

      .history-operation-text {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .history-operation-meta {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--vscode-descriptionForeground, #888);
      }
    `;
    document.head.appendChild(style);
  }

  private notifyLayoutChange(): void {
    window.dispatchEvent(new CustomEvent('easyview-editor-layout-change'));
  }

  private scheduleLayoutChangeNotifications(): void {
    const notify = () => this.notifyLayoutChange();
    notify();
    requestAnimationFrame(notify);
    setTimeout(notify, 60);
    setTimeout(notify, 220);
  }

  private attachPanelTransitionListener(): void {
    if (this.panel.dataset.easyviewLayoutBound === '1') return;
    this.panel.dataset.easyviewLayoutBound = '1';
    this.panel.addEventListener('transitionend', (event) => {
      const property = event.propertyName;
      if (
        property === 'width' ||
        property === 'min-width' ||
        property === 'margin-right' ||
        property === 'padding-left' ||
        property === 'padding-right'
      ) {
        this.notifyLayoutChange();
      }
    });
  }

  open() {
    this._visible = true;
    this.panel.classList.remove('hidden');
    this.render();
    this.refreshTimer = setInterval(() => this.render(), 500);
    this.deps.onVisibilityChange?.(true);
    this.scheduleLayoutChangeNotifications();
  }

  close() {
    this._visible = false;
    this.panel.classList.add('hidden');
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.deps.onVisibilityChange?.(false);
    this.scheduleLayoutChangeNotifications();
  }

  toggle() {
    if (this._visible) this.close();
    else this.open();
  }

  refresh() {
    if (this._visible) this.render();
  }

  private getDepths(): { undos: number; redos: number; isSource: boolean } {
    const view = this.deps.getView();
    const sourceView = this.deps.getSourceView();
    const isSource = this.deps.getIsSourceMode();

    if (isSource && sourceView) {
      return {
        undos: cmUndoDepth(sourceView.state),
        redos: cmRedoDepth(sourceView.state),
        isSource,
      };
    }
    if (view) {
      return {
        undos: undoDepth(view.state),
        redos: redoDepth(view.state),
        isSource,
      };
    }
    return { undos: 0, redos: 0, isSource };
  }

  private syncOperationLog(undos: number, redos: number, isSource: boolean): void {
    this.deps.getOperationLog().sync(undos, redos, isSource ? 'source' : 'wysiwyg');
  }

  private undoSteps(steps: number): void {
    for (let index = 0; index < steps; index++) {
      this.deps.triggerUndo();
    }
    this.render();
  }

  private redoSteps(steps: number): void {
    for (let index = 0; index < steps; index++) {
      this.deps.triggerRedo();
    }
    this.render();
  }

  private render() {
    const view = this.deps.getView();
    const dualHistory = this.deps.getDualHistory();
    const operationLog = this.deps.getOperationLog();
    const { undos, redos, isSource } = this.getDepths();
    this.syncOperationLog(undos, redos, isSource);

    this.contentEl.innerHTML = '';

    const statusEl = document.createElement('div');
    statusEl.className = 'history-panel-status';
    const modeLabel = isSource ? 'Source' : 'WYSIWYG';
    statusEl.innerHTML = `
      <div class="history-status-mode">
        <span class="history-dot ${isSource ? 'source' : 'wysiwyg'}"></span>
        ${modeLabel}
      </div>
      <div class="history-status-counts">
        Undo: <strong>${undos}</strong> &nbsp; Redo: <strong>${redos}</strong>
      </div>
    `;
    this.contentEl.appendChild(statusEl);

    const actionsEl = document.createElement('div');
    actionsEl.className = 'history-panel-actions';

    const undoBtn = document.createElement('button');
    undoBtn.className = 'history-action-btn';
    undoBtn.textContent = 'Undo';
    undoBtn.disabled = undos === 0;
    undoBtn.addEventListener('click', () => {
      this.deps.triggerUndo();
      this.render();
    });

    const redoBtn = document.createElement('button');
    redoBtn.className = 'history-action-btn';
    redoBtn.textContent = 'Redo';
    redoBtn.disabled = redos === 0;
    redoBtn.addEventListener('click', () => {
      this.deps.triggerRedo();
      this.render();
    });

    actionsEl.appendChild(undoBtn);
    actionsEl.appendChild(redoBtn);
    this.contentEl.appendChild(actionsEl);

    const listEl = document.createElement('div');
    listEl.className = 'history-operation-list';

    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'history-section-title';
    sectionTitle.textContent = '操作历史';
    listEl.appendChild(sectionTitle);

    const redoEntries = [...operationLog.getRedoEntries()].reverse();
    for (let index = 0; index < redoEntries.length; index++) {
      const entry = redoEntries[index];
      const steps = redoEntries.length - index;
      listEl.appendChild(this.createOperationEntry({
        label: entry.label,
        mode: entry.mode,
        meta: `Redo ${steps}`,
        future: true,
        onActivate: () => this.redoSteps(steps),
      }));
    }

    const currentEl = document.createElement('div');
    currentEl.className = 'history-operation-entry current';
    currentEl.innerHTML = `
      <span class="history-dot ${isSource ? 'source' : 'wysiwyg'}"></span>
      <span class="history-operation-text"><em>当前位置</em></span>
    `;
    listEl.appendChild(currentEl);

    const undoEntries = [...operationLog.getUndoEntries()].reverse();
    for (let index = 0; index < undoEntries.length; index++) {
      const entry = undoEntries[index];
      const steps = index + 1;
      listEl.appendChild(this.createOperationEntry({
        label: entry.label,
        mode: entry.mode,
        meta: `Undo ${steps}`,
        future: false,
        onActivate: () => this.undoSteps(steps),
      }));
    }

    if (undoEntries.length === 0 && redoEntries.length === 0) {
      const emptyEl = document.createElement('div');
      emptyEl.className = 'history-snapshot-entry';
      emptyEl.style.opacity = '0.65';
      emptyEl.textContent = '暂无操作记录';
      listEl.appendChild(emptyEl);
    }

    this.contentEl.appendChild(listEl);

    const undoStack = dualHistory.getUndoStack();
    const redoStack = dualHistory.getRedoStack();
    if (undoStack.length > 0 || redoStack.length > 0) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'history-panel-section';

      const crossTitle = document.createElement('div');
      crossTitle.className = 'history-section-title';
      crossTitle.textContent = 'Cross-mode snapshots';
      sectionEl.appendChild(crossTitle);

      for (let index = redoStack.length - 1; index >= 0; index--) {
        sectionEl.appendChild(this.createSnapshotEntry(redoStack[index], true));
      }

      const nowEl = document.createElement('div');
      nowEl.className = 'history-snapshot-entry current';
      nowEl.innerHTML = `<span class="history-dot ${isSource ? 'source' : 'wysiwyg'}"></span> <em>Current (${modeLabel})</em>`;
      sectionEl.appendChild(nowEl);

      for (let index = undoStack.length - 1; index >= 0; index--) {
        sectionEl.appendChild(this.createSnapshotEntry(undoStack[index], false));
      }

      this.contentEl.appendChild(sectionEl);
    }

    void view;
  }

  private createOperationEntry(options: {
    label: string;
    mode: 'wysiwyg' | 'source';
    meta: string;
    future: boolean;
    onActivate: () => void;
  }): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `history-operation-entry${options.future ? ' future' : ''}`;
    button.title = options.future
      ? `重做 ${options.meta.replace('Redo ', '')} 步`
      : `撤销 ${options.meta.replace('Undo ', '')} 步`;

    const dot = document.createElement('span');
    dot.className = `history-dot ${options.mode}`;
    button.appendChild(dot);

    const text = document.createElement('span');
    text.className = 'history-operation-text';
    text.textContent = options.label;
    button.appendChild(text);

    const meta = document.createElement('span');
    meta.className = 'history-operation-meta';
    meta.textContent = options.meta;
    button.appendChild(meta);

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.onActivate();
    });
    return button;
  }

  private createSnapshotEntry(entry: { markdown: string; mode: string }, isFuture: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `history-snapshot-entry${isFuture ? ' future' : ''}`;

    const dot = document.createElement('span');
    dot.className = `history-dot ${entry.mode}`;
    el.appendChild(dot);

    const text = document.createElement('span');
    text.className = 'history-snapshot-text';
    const modeStr = entry.mode === 'source' ? 'Source' : 'WYSIWYG';
    text.textContent = modeStr;
    text.title = `${modeStr} — ${entry.markdown.length} chars`;
    el.appendChild(text);

    return el;
  }
}
