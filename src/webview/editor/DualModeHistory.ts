/**
 * DualModeHistory
 *
 * Bridges undo/redo history between ProseMirror (WYSIWYG) and CodeMirror (source) modes.
 * Records snapshots on mode switch so that when native undo stack is exhausted,
 * the system can switch back to the previous mode and continue undoing there.
 *
 * Flow:
 * 1. User edits in WYSIWYG mode
 * 2. Switches to source mode → snapshot saved: {markdown, mode: 'wysiwyg'}
 * 3. User edits in source mode
 * 4. User presses Ctrl+Z, exhausting source undo → DualModeHistory kicks in:
 *    - Pops snapshot, switches to WYSIWYG, restores content
 *    - Native PM undo becomes available for prior WYSIWYG edits
 */

export interface ModeSnapshot {
  markdown: string;
  mode: 'wysiwyg' | 'source';
  /** Saved editor state (PM EditorState or CM6 EditorState) for exact restoration */
  editorState?: any;
}

export class DualModeHistory {
  private undoStack: ModeSnapshot[] = [];
  private redoStack: ModeSnapshot[] = [];

  /**
   * Record a snapshot when switching modes.
   * Call BEFORE the actual mode switch occurs.
   *
   * @param markdown - current document content
   * @param currentMode - the mode we're leaving
   */
  recordModeSwitch(markdown: string, currentMode: 'wysiwyg' | 'source', editorState?: any): void {
    // Don't record if content is identical to the last snapshot (no-op mode switch)
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && top.markdown === markdown) return;
    this.undoStack.push({ markdown, mode: currentMode, editorState });
    // Mode switch clears redo stack (like normal editing)
    this.redoStack.length = 0;
  }

  /**
   * Try to perform a cross-mode undo.
   * Call when native undo fails (stack exhausted) in the current mode.
   *
   * @returns snapshot to restore, or null if no cross-mode undo available
   */
  crossModeUndo(currentMarkdown: string, currentMode: 'wysiwyg' | 'source'): ModeSnapshot | null {
    if (this.undoStack.length === 0) return null;
    const snapshot = this.undoStack.pop()!;

    // Save current state for redo
    this.redoStack.push({ markdown: currentMarkdown, mode: currentMode });

    return snapshot;
  }

  /**
   * Try to perform a cross-mode redo.
   * Call when native redo fails (stack exhausted) in the current mode.
   *
   * @returns snapshot to restore, or null if no cross-mode redo available
   */
  crossModeRedo(currentMarkdown: string, currentMode: 'wysiwyg' | 'source'): ModeSnapshot | null {
    if (this.redoStack.length === 0) return null;
    const snapshot = this.redoStack.pop()!;

    // Save current state for undo
    this.undoStack.push({ markdown: currentMarkdown, mode: currentMode });

    return snapshot;
  }

  /** Peek at the top undo entry without modifying stacks */
  peekUndo(): ModeSnapshot | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  /** Discard identical entries from top of undo stack */
  skipIdenticalUndos(currentMarkdown: string): void {
    while (this.undoStack.length > 0 && this.undoStack[this.undoStack.length - 1].markdown === currentMarkdown) {
      this.undoStack.pop();
    }
  }

  /** Check if cross-mode undo is available */
  canCrossModeUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Check if cross-mode redo is available */
  canCrossModeRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Clear all history (e.g. on document reload) */
  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
