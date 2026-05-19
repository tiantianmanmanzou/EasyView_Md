/**
 * History Panel — slide-out panel that VISUALIZES existing undo/redo state.
 *
 * Reads directly from:
 * - ProseMirror history (undoDepth/redoDepth)
 * - CodeMirror history
 * - DualModeHistory (cross-mode snapshots)
 *
 * Does NOT maintain its own history state.
 */

import { undo, redo, undoDepth, redoDepth } from 'prosemirror-history';
import { undoDepth as cmUndoDepth, redoDepth as cmRedoDepth } from '@codemirror/commands';
import type { EditorView } from 'prosemirror-view';
import type { DualModeHistory } from '../editor/DualModeHistory';

export interface HistoryPanelDeps {
  getView: () => EditorView | null;
  getDualHistory: () => DualModeHistory;
  getIsSourceMode: () => boolean;
  getSourceView: () => import('@codemirror/view').EditorView | null;
  triggerUndo: () => void;
  triggerRedo: () => void;
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
    this.panel = document.createElement('div');
    this.panel.className = 'history-panel hidden';

    // Header
    const header = document.createElement('div');
    header.className = 'history-panel-header';
    header.innerHTML = `
      <span class="history-panel-title">History</span>
      <button class="history-panel-close" title="Close">&times;</button>
    `;
    header.querySelector('.history-panel-close')!.addEventListener('click', () => this.close());
    this.panel.appendChild(header);

    // Content area
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'history-panel-content';
    this.panel.appendChild(this.contentEl);

    // Insert into #editor-body
    const editorBody = document.getElementById('editor-body');
    if (editorBody) {
      editorBody.appendChild(this.panel);
    }
  }

  open() {
    this._visible = true;
    this.panel.classList.remove('hidden');
    this.render();
    // Auto-refresh every 500ms while open (timestamps + depth changes)
    this.refreshTimer = setInterval(() => this.render(), 500);
  }

  close() {
    this._visible = false;
    this.panel.classList.add('hidden');
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  toggle() {
    if (this._visible) this.close();
    else this.open();
  }

  /** Force re-render (call after undo/redo/mode switch) */
  refresh() {
    if (this._visible) this.render();
  }

  private render() {
    const view = this.deps.getView();
    const sourceView = this.deps.getSourceView();
    const isSource = this.deps.getIsSourceMode();
    const dualHistory = this.deps.getDualHistory();

    this.contentEl.innerHTML = '';

    // ─── Current mode status ───
    const statusEl = document.createElement('div');
    statusEl.className = 'history-panel-status';

    const modeLabel = isSource ? 'Source' : 'WYSIWYG';
    let undos = 0, redos = 0;

    if (isSource && sourceView) {
      undos = cmUndoDepth(sourceView.state);
      redos = cmRedoDepth(sourceView.state);
    } else if (view) {
      undos = undoDepth(view.state);
      redos = redoDepth(view.state);
    }

    const undoText = undos >= 0 ? `${undos}` : '?';
    const redoText = redos >= 0 ? `${redos}` : '?';
    statusEl.innerHTML = `
      <div class="history-status-mode">
        <span class="history-dot ${isSource ? 'source' : 'wysiwyg'}"></span>
        ${modeLabel}
      </div>
      <div class="history-status-counts">
        Undo: <strong>${undoText}</strong> &nbsp; Redo: <strong>${redoText}</strong>
      </div>
    `;
    this.contentEl.appendChild(statusEl);

    // ─── Undo/Redo buttons ───
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

    // Undo all button
    if (undos > 1) {
      const undoAllBtn = document.createElement('button');
      undoAllBtn.className = 'history-action-btn secondary';
      undoAllBtn.textContent = `Undo all (${undoText})`;
      undoAllBtn.addEventListener('click', () => {
        for (let i = 0; i < undos; i++) this.deps.triggerUndo();
        this.render();
      });
      actionsEl.appendChild(undoAllBtn);
    }

    this.contentEl.appendChild(actionsEl);

    // ─── Cross-mode history (DualModeHistory snapshots) ───
    const undoStack = (dualHistory as any).undoStack as Array<{ markdown: string; mode: string }>;
    const redoStack = (dualHistory as any).redoStack as Array<{ markdown: string; mode: string }>;

    if (undoStack.length > 0 || redoStack.length > 0) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'history-panel-section';

      const sectionTitle = document.createElement('div');
      sectionTitle.className = 'history-section-title';
      sectionTitle.textContent = 'Cross-mode snapshots';
      sectionEl.appendChild(sectionTitle);

      // Redo stack (future) — shown in reverse, dimmed
      for (let i = redoStack.length - 1; i >= 0; i--) {
        const entry = redoStack[i];
        const el = this.createSnapshotEntry(entry, true);
        sectionEl.appendChild(el);
      }

      // Current position marker
      const nowEl = document.createElement('div');
      nowEl.className = 'history-snapshot-entry current';
      nowEl.innerHTML = `<span class="history-dot ${isSource ? 'source' : 'wysiwyg'}"></span> <em>Current (${modeLabel})</em>`;
      sectionEl.appendChild(nowEl);

      // Undo stack (past) — shown in reverse (most recent first)
      for (let i = undoStack.length - 1; i >= 0; i--) {
        const entry = undoStack[i];
        const el = this.createSnapshotEntry(entry, false);
        sectionEl.appendChild(el);
      }

      this.contentEl.appendChild(sectionEl);
    }
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
