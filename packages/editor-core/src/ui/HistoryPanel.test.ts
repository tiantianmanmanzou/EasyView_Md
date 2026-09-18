/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorView } from 'prosemirror-view';
import type { EditorView as CodeMirrorEditorView } from '@codemirror/view';

import { DualModeHistory } from '../editor/DualModeHistory';
import { EditOperationLog } from '../editor/EditOperationLog';
import { HistoryPanel } from './HistoryPanel';

function createDeps(overrides: Partial<ConstructorParameters<typeof HistoryPanel>[0]> = {}) {
  const deps = {
    getView: () => null as EditorView | null,
    getDualHistory: () => new DualModeHistory(),
    getOperationLog: () => new EditOperationLog(),
    getIsSourceMode: () => false,
    getSourceView: () => null as CodeMirrorEditorView | null,
    triggerUndo: vi.fn(),
    triggerRedo: vi.fn(),
    onVisibilityChange: vi.fn(),
    ...overrides,
  };
  return deps;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('HistoryPanel lifecycle', () => {
  it('destroys its panel and removes visibility and transition callbacks idempotently', () => {
    const editorBody = document.createElement('div');
    editorBody.id = 'editor-body';
    document.body.appendChild(editorBody);

    const onVisibilityChange = vi.fn();
    const panel = new HistoryPanel(createDeps({ onVisibilityChange }));

    panel.open();
    expect(editorBody.querySelector('.history-panel')).not.toBeNull();
    expect(onVisibilityChange).toHaveBeenCalledWith(true);

    panel.destroy();
    panel.destroy();

    expect(editorBody.querySelector('.history-panel')).toBeNull();
    expect(panel.visible).toBe(false);

    panel.open();
    panel.close();
    panel.toggle();
    panel.refresh();
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new TransitionEvent('transitionend', { propertyName: 'width' }));
    expect(onVisibilityChange).toHaveBeenCalledTimes(1);
  });

  it('clears refresh timers when destroyed', () => {
    vi.useFakeTimers();
    const editorBody = document.createElement('div');
    editorBody.id = 'editor-body';
    document.body.appendChild(editorBody);

    const getView = vi.fn(() => null as EditorView | null);
    const panel = new HistoryPanel(createDeps({ getView }));

    panel.open();
    const renderCallCountAfterOpen = getView.mock.calls.length;
    panel.destroy();

    vi.advanceTimersByTime(1000);
    expect(getView.mock.calls.length).toBe(renderCallCountAfterOpen);
  });
});
