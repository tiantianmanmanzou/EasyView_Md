import { describe, expect, it } from 'vitest';
import { DualModeHistory } from './DualModeHistory';

describe('DualModeHistory', () => {
  it('records a mode switch and restores it via crossModeUndo', () => {
    const history = new DualModeHistory();
    history.recordModeSwitch('# doc A wysiwyg', 'wysiwyg');

    expect(history.canCrossModeUndo()).toBe(true);
    const snapshot = history.crossModeUndo('# doc A source', 'source');
    expect(snapshot?.markdown).toBe('# doc A wysiwyg');
    expect(snapshot?.mode).toBe('wysiwyg');
  });

  it('does not record a duplicate snapshot for a no-op mode switch', () => {
    const history = new DualModeHistory();
    history.recordModeSwitch('same content', 'wysiwyg');
    history.recordModeSwitch('same content', 'source');
    expect(history.getUndoStack()).toHaveLength(1);
  });

  it('clear() empties both stacks so a stale snapshot cannot be restored later', () => {
    // Regression test for cross-document undo leakage: switching documents while an
    // editor-core instance is reused (desktop tab switch) must not let a previous
    // document's cross-mode snapshot be restored into the newly loaded document once
    // its own native undo stack is exhausted.
    const history = new DualModeHistory();
    history.recordModeSwitch('# doc A wysiwyg', 'wysiwyg');
    expect(history.canCrossModeUndo()).toBe(true);

    // Simulated document switch: the host layer must call clear() here.
    history.clear();

    expect(history.canCrossModeUndo()).toBe(false);
    expect(history.crossModeUndo('# doc B wysiwyg', 'wysiwyg')).toBeNull();
    expect(history.canCrossModeRedo()).toBe(false);
  });

  it('crossModeRedo restores the most recent undone snapshot', () => {
    const history = new DualModeHistory();
    history.recordModeSwitch('v1', 'wysiwyg');
    const undone = history.crossModeUndo('v2', 'source');
    expect(undone?.markdown).toBe('v1');

    const redone = history.crossModeRedo('v2', 'source');
    expect(redone?.markdown).toBe('v2');
    expect(redone?.mode).toBe('source');
  });
});
