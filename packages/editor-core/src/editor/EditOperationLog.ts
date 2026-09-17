export type EditOperationMode = 'wysiwyg' | 'source';

export interface EditOperationEntry {
  label: string;
  mode: EditOperationMode;
}

export class EditOperationLog {
  private undoEntries: EditOperationEntry[] = [];
  private redoEntries: EditOperationEntry[] = [];
  private lastUndoDepth = 0;
  private lastRedoDepth = 0;
  private pendingLabel: string | null = null;
  private pendingMode: EditOperationMode = 'wysiwyg';

  clear(): void {
    this.undoEntries = [];
    this.redoEntries = [];
    this.lastUndoDepth = 0;
    this.lastRedoDepth = 0;
    this.pendingLabel = null;
  }

  notePendingLabel(label: string, mode: EditOperationMode): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    this.pendingLabel = trimmed;
    this.pendingMode = mode;
  }

  sync(undoDepth: number, redoDepth: number, mode: EditOperationMode): void {
    if (undoDepth > this.lastUndoDepth) {
      const added = undoDepth - this.lastUndoDepth;
      for (let index = 0; index < added; index++) {
        const isLatest = index === added - 1;
        this.undoEntries.push({
          label: isLatest && this.pendingLabel ? this.pendingLabel : '编辑文档',
          mode: isLatest && this.pendingLabel ? this.pendingMode : mode,
        });
      }
      this.redoEntries = [];
    } else if (undoDepth < this.lastUndoDepth) {
      const removed = this.lastUndoDepth - undoDepth;
      for (let index = 0; index < removed; index++) {
        const entry = this.undoEntries.pop();
        if (entry) this.redoEntries.push(entry);
      }
    }

    if (undoDepth === this.lastUndoDepth && redoDepth > this.lastRedoDepth) {
      const restored = redoDepth - this.lastRedoDepth;
      for (let index = 0; index < restored; index++) {
        const entry = this.redoEntries.pop();
        if (entry) this.undoEntries.push(entry);
      }
    } else if (redoDepth < this.lastRedoDepth && undoDepth === this.lastUndoDepth) {
      this.redoEntries = this.redoEntries.slice(0, redoDepth);
    }

    while (this.undoEntries.length > undoDepth) {
      this.undoEntries.pop();
    }
    while (this.undoEntries.length < undoDepth) {
      this.undoEntries.push({ label: '编辑文档', mode });
    }
    while (this.redoEntries.length > redoDepth) {
      this.redoEntries.pop();
    }
    while (this.redoEntries.length < redoDepth) {
      this.redoEntries.push({ label: '重做', mode });
    }

    this.lastUndoDepth = undoDepth;
    this.lastRedoDepth = redoDepth;
    this.pendingLabel = null;
  }

  getUndoEntries(): readonly EditOperationEntry[] {
    return this.undoEntries;
  }

  getRedoEntries(): readonly EditOperationEntry[] {
    return this.redoEntries;
  }
}
